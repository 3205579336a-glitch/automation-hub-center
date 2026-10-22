"""Verified SAP GUI startup only: never save, discard, log off or replay a transaction.

949/321 identify SAP Logon entries, NOT SAP clients (both normally use 100).
Keep one connector per run so a failed/slow OpenConnection is never repeated.
"""
import re
import time

SAP_CONNECTION_POLICY = 'verified-startup-v1'


class SapGuiIssue(RuntimeError):
    def __init__(self, code, en, zh, details=""):
        self.code = code
        self.issue_summary = en
        self.issue_summary_zh = zh
        super().__init__(f"[{code}] {en}" + (f"\n{details}" if details else ""))


def children(owner, alias):
    """SAP exposes Children/Connections and Children/Sessions as synonyms.

    Preserve BOTH COM failures, including server scripting error 624. Never
    turn inaccessible collections into an empty (supposedly absent) connection.
    """
    errors = []
    for name in ("Children", alias):
        try:
            collection = getattr(owner, name)
            count = collection.Count
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError(f"Invalid {name}.Count: {count!r}")
            return [collection(index) for index in range(count)]
        except Exception as error:
            errors.append(f"{name}: {error}")
    raise SapGuiIssue("SAP_COLLECTION_UNREADABLE",
        "SAP windows cannot be read. Ask IT to check SAP GUI Scripting access; do not close existing business windows.",
        "无法读取 SAP 窗口。请让 IT 检查 SAP GUI Scripting 权限；无需关闭已有业务窗口。", " | ".join(errors))


def connection_label(connection):
    errors = []
    for name in ("Description", "Name"):
        try:
            value = getattr(connection, name)
            if isinstance(value, str) and value.strip() and not re.fullmatch(r"(?:/app/)?(?:con|conn|connection)\[\d+\]", value.strip(), re.IGNORECASE):
                return value.strip()
        except Exception as error:
            errors.append(f"{name}: {error}")
    raise SapGuiIssue("SAP_CONNECTION_LABEL_UNREADABLE",
        "The SAP Logon entry cannot be identified. No extra login will be opened.",
        "无法确认 SAP Logon 连接名称；为避免重复登录，不会另开连接。", " | ".join(errors))


def assert_scripting_enabled(connection):
    # Older clients may not expose this optional property. Collection access is
    # still mandatory and propagates the original server error in that case.
    try:
        disabled = connection.DisabledByServer
    except Exception:
        disabled = False
    if disabled is True or type(disabled) is int and disabled != 0:
        raise SapGuiIssue("SAP_SCRIPTING_DISABLED",
            "SAP GUI Scripting is disabled for this connection. Ask IT/SAP support to enable the approved access.",
            "此连接未开放 SAP GUI Scripting。请联系 IT/SAP 支持确认脚本权限；重新登录不能解决此权限问题。")


def session_children(connection):
    assert_scripting_enabled(connection)
    return children(connection, "Sessions")


def read_identity(session):
    info = session.Info
    values = [getattr(info, name) for name in ("SystemName", "Client", "User")]
    if not all(isinstance(value, str) for value in values):
        raise ValueError("SAP identity contains a non-text System/Client/User")
    return tuple(value.strip() for value in values)


def busy(session):
    value = session.Busy
    if not isinstance(value, (bool, int)):
        raise ValueError("SAP Busy state is unreadable")
    return bool(value)


class _CompatibleCollection:
    """Read only the requested Count/item, not every sibling on each access."""
    def __init__(self, owner, application):
        self.owner, self.is_application = owner, application

    def read(self, action):
        if not self.is_application:
            assert_scripting_enabled(self.owner)
        errors = []
        for name in ('Children', 'Connections' if self.is_application else 'Sessions'):
            try:
                return action(getattr(self.owner, name))
            except Exception as error:
                errors.append(f'{name}: {error}')
        raise SapGuiIssue('SAP_COLLECTION_UNREADABLE',
            'SAP windows cannot be read. Ask IT to check SAP GUI Scripting access; do not close existing business windows.',
            '无法读取 SAP 窗口。请让 IT 检查 SAP GUI Scripting 权限；无需关闭已有业务窗口。', ' | '.join(errors))

    @property
    def Count(self):
        def count(collection):
            value = collection.Count
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f'Invalid collection Count: {value!r}')
            return value
        return self.read(count)

    def __call__(self, index):
        value = self.read(lambda collection: collection(index))
        return GuiCollectionAccess(value, False) if self.is_application else value


class GuiCollectionAccess:
    """Compatibility view for APQP's existing, independently verified startup.

    No session wrapping or business-method changes. Count/items stay live so an
    asynchronously opened connection remains discoverable, without N² scanning.
    """
    def __init__(self, owner, application=True):
        self.owner, self.is_application = owner, application

    def __getattr__(self, name):
        return getattr(self.owner, name)

    @property
    def Children(self):
        return _CompatibleCollection(self.owner, self.is_application)


def show_window(session, shown):
    """Restore this verified target's owner and modal; never click a dialog."""
    import win32con
    import win32gui
    main = session.FindById("wnd[0]", False)
    modal = session.FindById("wnd[1]", False)
    windows = [window for window in (main, modal) if window is not None]
    handles = [int(window.Handle) for window in windows]
    if not handles or not all(win32gui.IsWindow(handle) for handle in handles):
        raise RuntimeError("SAP window handle is unavailable")
    if handles[-1] in shown:
        return
    for handle in handles:
        win32gui.ShowWindow(handle, win32con.SW_RESTORE)
    win32gui.SetForegroundWindow(handles[-1])
    shown.add(handles[-1])


class SapGuiConnector:
    def __init__(self, name, system, client, user="", *, launch=None, stop=None,
                 cancelled=None, wait_seconds=5.0, display=None):
        self.name, self.system, self.client, self.user = name, system.upper(), client, user
        self.launch, self.stop, self.cancelled = launch, stop, cancelled
        self.wait_seconds, self.display = wait_seconds, display or show_window
        self.open_attempted = self.launch_attempted = False
        self.shown = set()

    def check_stop(self):
        if self.stop and self.stop():
            if self.cancelled:
                raise self.cancelled()
            raise InterruptedError("Stopped before SAP startup completed")

    def application(self):
        import win32com.client
        self.check_stop()
        try:
            return win32com.client.GetObject("SAPGUI").GetScriptingEngine
        except Exception as error:
            if self.launch and not self.launch_attempted:
                self.launch_attempted = True
                try:
                    self.launch()
                except Exception as launch_error:
                    raise SapGuiIssue("SAP_LOGON_START_FAILED", "SAP Logon could not be started.",
                        "无法启动 SAP Logon，请确认已安装公司 SAP GUI。", str(launch_error)) from launch_error
                deadline = time.monotonic() + self.wait_seconds
                while time.monotonic() < deadline:
                    self.check_stop()
                    try:
                        return win32com.client.GetObject("SAPGUI").GetScriptingEngine
                    except Exception:
                        time.sleep(0.1)
            raise SapGuiIssue("SAP_GUI_UNAVAILABLE",
                "SAP Logon/Scripting is not ready. Complete startup, then Check Again.",
                "SAP Logon/脚本引擎尚未就绪。请完成启动后点击重新检查。", str(error)) from error

    def matches(self, label):
        expected = " ".join(self.name.casefold().split())
        actual = " ".join(label.casefold().split())
        code = re.search(r"\[\d+\]", expected)
        return actual == expected or bool(code and code.group() in actual)

    def select(self, application=None):
        self.check_stop()
        application = application if application is not None else self.application()
        connections = children(application, "Connections")
        labels = [connection_label(connection) for connection in connections]
        targets = [index for index, label in enumerate(labels) if self.matches(label)]
        if len(targets) > 1:
            raise SapGuiIssue("SAP_TARGET_AMBIGUOUS", "Multiple target SAP connections are open. Verify the intended login.",
                "存在多个目标 SAP 连接，请确认应使用的登录；Hub 不会关闭其他登录。")
        if targets:
            index = targets[0]
            return self._select_session(connections[index], labels[index], index)

        # An alias may point to the same backend. Prove absence before opening.
        for connection in connections:
            for session in session_children(connection):
                try:
                    system, _, _ = read_identity(session)
                except Exception as error:
                    raise SapGuiIssue("SAP_SESSION_UNREADABLE", "SAP session identity cannot be read. No duplicate login will be opened.",
                        "无法读取 SAP 会话身份；为避免重复登录，不会另开连接。", str(error)) from error
                if not system or system.upper() == self.system:
                    raise SapGuiIssue("SAP_TARGET_ALIAS", "An existing SAP connection may use the same backend. Verify its Logon entry first.",
                        "已有连接可能指向同一 SAP 系统，请核对 Logon 连接名称后重新检查；不会重复登录。")
        if not self.open_attempted:
            self.check_stop()
            self.open_attempted = True  # Even a COM failure may have opened it.
            try:
                application.OpenConnection(self.name, False)
            except Exception as error:
                raise SapGuiIssue("SAP_OPEN_CONNECTION_FAILED", "The target SAP connection could not be confirmed. Check SAP Logon before retrying.",
                    "未能确认目标 SAP 连接是否打开，请检查 SAP Logon 后重新检查；不会重复打开。", str(error)) from error
            # Allow fast SSO to settle, but do not hide a login dialog for 180s.
            deadline = time.monotonic() + self.wait_seconds
            while time.monotonic() < deadline:
                self.check_stop()
                current = children(application, "Connections")
                if any(self.matches(connection_label(connection)) for connection in current):
                    return self.select(application)
                time.sleep(0.1)
        raise SapGuiIssue("SAP_CONNECTION_STARTING", "SAP connection startup is pending. Complete any SAP login prompt, then Check Again.",
            "SAP 连接正在启动，请完成 SAP 登录提示后点击重新检查；不会重复打开连接。")

    def _select_session(self, connection, label, connection_index):
        sessions = session_children(connection)
        issues = []
        ready_sessions = []
        for session_index, session in enumerate(sessions):
            self.check_stop()
            try:
                # Info/window reads may block while SAP is processing. Busy is
                # read first; a busy session is never interpreted as signed out.
                if busy(session):
                    raise SapGuiIssue("SAP_BUSY", "SAP is busy. Wait until it responds, then Check Again.", "SAP 正忙，请等待 SAP 响应后重新检查。")
                system, client, user = read_identity(session)
                if ((system and self.system and system.upper() != self.system)
                        or (client and self.client and client != self.client)
                        or (user and self.user and user != self.user)):
                    raise SapGuiIssue("SAP_IDENTITY_MISMATCH", "The SAP System/Client/User does not match this task. No other login will be opened.",
                        "当前 SAP 系统、Client 或用户与任务设置不符；不会自动切换其他登录。",
                        f"Expected System={self.system}, Client={self.client}; observed System={system}, Client={client}; userMatch={not self.user or user == self.user}")
                main = session.FindById("wnd[0]", False)
                modal = session.FindById("wnd[1]", False)
                if main is None:
                    raise SapGuiIssue("SAP_WINDOW_UNAVAILABLE", "The SAP main window is not ready. Check SAP Logon.", "SAP 主窗口尚未就绪，请检查 SAP Logon。")
                if modal is not None or not all((system, client, user)):
                    title = str(modal.Text).casefold() if modal is not None else ""
                    multiple = any(word in title for word in ("multiple logon", "multiple login", "多重登录", "重复登录"))
                    issue = SapGuiIssue("SAP_MULTIPLE_LOGONS" if multiple else "SAP_LOGIN_DIALOG" if modal is not None else "SAP_LOGIN_REQUIRED",
                        "Handle the SAP multiple-logon notice according to company policy; the Hub will not end other logons." if multiple else
                        "Complete SAP sign-in or handle the open SAP dialog, then Check Again. The Hub will not choose Save/Discard for you.",
                        "请按公司规定处理 SAP 多重登录提示；Hub 不会结束其他登录。" if multiple else
                        "请完成 SAP 登录或处理已有弹窗后重新检查；Hub 不会代选保存、放弃或登录选项。")
                    try:
                        self.display(session, self.shown)
                    except Exception as error:
                        issue = SapGuiIssue(issue.code, issue.issue_summary, issue.issue_summary_zh, "Window display: " + str(error))
                    raise issue
                transaction = session.Info.Transaction
                if not isinstance(transaction, str) or not transaction.strip():
                    raise ValueError("Signed-in SAP transaction cannot be verified")
                ready_sessions.append((session, dict(system=system.upper(), client=client, user=user, transaction=transaction.upper(),
                    connection_index=connection_index, session_index=session_index,
                    connection_description=label, target_verified=True)))
            except SapGuiIssue as error:
                issues.append(error)
            except Exception as error:
                issues.append(SapGuiIssue("SAP_SESSION_UNREADABLE", "SAP session identity/window cannot be read. Check SAP GUI Scripting access with IT.",
                    "无法读取 SAP 会话身份或窗口，请让 IT 检查 SAP GUI Scripting 权限。", str(error)))
        if ready_sessions:
            # Prefer an already idle home window over someone else's business
            # screen, without creating a new session or navigating during scan.
            return min(ready_sessions, key=lambda candidate: candidate[1]['transaction'] not in {'SESSION_MANAGER', 'S000'})
        if issues:
            first = issues[0]
            raise SapGuiIssue(first.code, first.issue_summary, first.issue_summary_zh,
                "\n".join(f"Window {index + 1}: {error}" for index, error in enumerate(issues)))
        raise SapGuiIssue("SAP_NO_SESSION", "The target connection exists, but its SAP window is not ready. Complete SAP startup, then Check Again.",
            "目标连接已存在，但 SAP 窗口尚未就绪。请完成 SAP 启动后重新检查；不会重复登录。")
