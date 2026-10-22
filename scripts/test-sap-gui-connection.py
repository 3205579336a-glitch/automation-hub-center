"""Offline regression of startup failures reported by a colleague. Never opens SAP."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources/rpa'))
from sap_gui_connection import SapGuiConnector, SapGuiIssue, GuiCollectionAccess, children, show_window
from sap_gui_fakes import application, connection, session, Collection


class Broken:
    def __getattr__(self, name):
        raise RuntimeError(f'{name}: COM error 624 / E_ACCESSDENIED')


class StopNow(BaseException):
    pass


class StartupTests(unittest.TestCase):
    def test_compatibility_access_reads_one_item_without_enumerating_siblings(self):
        class Counted(Collection):
            def __init__(self, values):
                super().__init__(values)
                self.reads = self.counts = 0
            @property
            def Count(self):
                self.counts += 1
                return len(self.values)
            def __call__(self, index):
                self.reads += 1
                return super().__call__(index)
        sessions = Counted([session() for _ in range(20)])
        connections = Counted([SimpleNamespace(Children=sessions)])
        wrapped = GuiCollectionAccess(SimpleNamespace(Children=connections))
        self.assertIs(wrapped.Children(0).Children(9), sessions.values[9])
        self.assertEqual((connections.reads, sessions.reads, connections.counts, sessions.counts), (1, 1, 0, 0))

    def connector(self, **kwargs):
        return SapGuiConnector('VCE - One Digital Core [949]', 'VCE', '100',
            display=Mock(), wait_seconds=0, **kwargs)

    def test_existing_window_on_other_transaction_is_reused_without_navigation(self):
        current = session(transaction='ME11')
        app = application([connection([current])])
        selected, meta = self.connector().select(app)
        self.assertIs(selected, current)
        self.assertEqual(meta['transaction'], 'ME11')
        self.assertEqual(meta['client'], '100')
        app.OpenConnection.assert_not_called()

    def test_collection_aliases_work_without_children(self):
        current = session()
        conn = SimpleNamespace(Description='VCE [949]', Sessions=Collection([current]))
        app = SimpleNamespace(Connections=Collection([conn]), OpenConnection=Mock())
        self.assertIs(self.connector().select(app)[0], current)
        app.OpenConnection.assert_not_called()

    def test_failed_children_count_falls_back_to_connections(self):
        app = application([connection([session()])])
        app.Children = Broken()
        self.assertEqual(self.connector().select(app)[1]['system'], 'VCE')

    def test_apqp_compatibility_view_preserves_raw_sessions_and_aliases(self):
        current = session()
        app = SimpleNamespace(Connections=Collection([
            SimpleNamespace(Description='VCE [949]', Sessions=Collection([current]))]))
        wrapped = GuiCollectionAccess(app)
        self.assertEqual(wrapped.Children.Count, 1)
        self.assertIs(wrapped.Children(0).Children(0), current)

    def test_apqp_view_does_not_swallow_server_disabled(self):
        wrapped = GuiCollectionAccess(application([connection(disabled=True)]))
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_SCRIPTING_DISABLED'):
            wrapped.Children(0).Children.Count

    def test_unreadable_inventory_preserves_both_com_causes(self):
        app = Broken()
        with self.assertRaises(SapGuiIssue) as result:
            self.connector().select(app)
        self.assertEqual(result.exception.code, 'SAP_COLLECTION_UNREADABLE')
        self.assertIn('Children: COM error 624', str(result.exception))
        self.assertIn('Connections: COM error 624', str(result.exception))

    def test_session_collection_error_is_not_a_login_pending_error(self):
        conn = connection()
        conn.Children = conn.Sessions = Broken()
        app = application([conn])
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_COLLECTION_UNREADABLE.*') as result:
            self.connector().select(app)
        self.assertIn('624', str(result.exception))
        app.OpenConnection.assert_not_called()

    def test_server_disabled_has_actionable_reason_and_never_opens_again(self):
        for disabled in (True, -1):
            app = application([connection([session()], disabled=disabled)])
            with self.assertRaisesRegex(SapGuiIssue, 'SAP_SCRIPTING_DISABLED'):
                self.connector().select(app)
            app.OpenConnection.assert_not_called()

    def test_identity_exception_is_not_swallowed_as_signed_out(self):
        current = session()
        current.Info = Broken()
        app = application([connection([current])])
        with self.assertRaises(SapGuiIssue) as result:
            self.connector().select(app)
        self.assertEqual(result.exception.code, 'SAP_SESSION_UNREADABLE')
        self.assertIn('E_ACCESSDENIED', str(result.exception))
        app.OpenConnection.assert_not_called()

    def test_wrong_system_client_and_user_are_never_used(self):
        for values in ({'system': 'CEQ'}, {'client': '949'}, {'user': 'OTHER'}):
            app = application([connection([session(**values)])])
            with self.assertRaisesRegex(SapGuiIssue, 'SAP_IDENTITY_MISMATCH'):
                self.connector(user='TEST_ONLY').select(app)
            app.OpenConnection.assert_not_called()

    def test_readable_healthy_session_can_be_used_alongside_busy_or_unreadable(self):
        unreadable = session()
        unreadable.Info = Broken()
        current = session()
        app = application([connection([session(busy=True), unreadable, current])])
        self.assertIs(self.connector().select(app)[0], current)

    def test_pending_login_window_is_shown_and_recheck_continues(self):
        connector = self.connector()
        current = session(user='')
        app = application([connection([current])])
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_LOGIN_REQUIRED'):
            connector.select(app)
        connector.display.assert_called_once_with(current, connector.shown)
        current.Info.User = 'TEST_ONLY'
        self.assertIs(connector.select(app)[0], current)
        app.OpenConnection.assert_not_called()

    def test_multiple_logon_is_shown_but_never_answered(self):
        current = session(user='', popup=True)
        modal = current.FindById('wnd[1]', False)
        modal.Text = 'License Information for Multiple Logons'
        app = application([connection([current])])
        connector = self.connector()
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_MULTIPLE_LOGONS'):
            connector.select(app)
        connector.display.assert_called_once()
        app.OpenConnection.assert_not_called()

    def test_popup_on_signed_in_window_blocks_business_start(self):
        app = application([connection([session(popup=True)])])
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_LOGIN_DIALOG'):
            self.connector().select(app)
        app.OpenConnection.assert_not_called()

    def test_new_connection_is_opened_once_even_after_pending_and_rechecks(self):
        app = application()
        connector = self.connector()
        for _ in range(3):
            with self.assertRaisesRegex(SapGuiIssue, 'SAP_CONNECTION_STARTING'):
                connector.select(app)
        app.OpenConnection.assert_called_once_with('VCE - One Digital Core [949]', False)
        current = session()
        app.Children.values.append(connection([current]))
        self.assertIs(connector.select(app)[0], current)
        self.assertEqual(app.OpenConnection.call_count, 1)

    def test_failed_open_does_not_repeat_an_ambiguous_com_action(self):
        app = application()
        app.OpenConnection.side_effect = RuntimeError('COM return failed after opening')
        connector = self.connector()
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_OPEN_CONNECTION_FAILED'):
            connector.select(app)
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_CONNECTION_STARTING'):
            connector.select(app)
        self.assertEqual(app.OpenConnection.call_count, 1)

    def test_qa_and_production_are_separate_and_client_100_is_preserved(self):
        qa = session(system='CEQ')
        prod = session()
        app = application([connection([qa], 'CEQ - One Digital Core - QA [321]'), connection([prod])])
        self.assertIs(self.connector().select(app)[0], prod)
        connector = SapGuiConnector('CEQ - One Digital Core - QA [321]', 'CEQ', '100', display=Mock())
        self.assertIs(connector.select(app)[0], qa)
        app.OpenConnection.assert_not_called()

    def test_alias_to_same_backend_does_not_cause_duplicate_login(self):
        app = application([connection([session()], 'Custom Production')])
        with self.assertRaisesRegex(SapGuiIssue, 'SAP_TARGET_ALIAS'):
            self.connector().select(app)
        app.OpenConnection.assert_not_called()

    def test_duplicate_targets_and_unreadable_labels_fail_closed(self):
        for connections in ([connection(), connection()], [SimpleNamespace(Name='con[0]')],
                            [SimpleNamespace(Name='connection[0]')], [SimpleNamespace(Name='/app/con[0]')]):
            app = application(connections)
            with self.assertRaises(SapGuiIssue):
                self.connector().select(app)
            app.OpenConnection.assert_not_called()

    def test_stop_prevents_any_connection_action(self):
        app = application()
        with self.assertRaises(StopNow):
            self.connector(stop=lambda: True, cancelled=StopNow).select(app)
        app.OpenConnection.assert_not_called()

    def test_busy_unreadable_window_and_empty_transaction_fail_closed(self):
        for current in (session(busy=True), session(busy='unknown'), session(transaction='')):
            app = application([connection([current])])
            with self.assertRaises(SapGuiIssue):
                self.connector().select(app)
            app.OpenConnection.assert_not_called()

    def test_only_verified_owner_and_modal_are_restored_no_dialog_clicks(self):
        current = session(popup=True)
        gui = SimpleNamespace(IsWindow=Mock(return_value=True), ShowWindow=Mock(), SetForegroundWindow=Mock())
        with patch.dict(sys.modules, win32gui=gui, win32con=SimpleNamespace(SW_RESTORE=9)):
            shown = set()
            show_window(current, shown)
            show_window(current, shown)
        self.assertEqual(gui.ShowWindow.call_args_list[0].args, (100, 9))
        self.assertEqual(gui.ShowWindow.call_args_list[1].args, (101, 9))
        self.assertEqual(gui.ShowWindow.call_count, 2)
        gui.SetForegroundWindow.assert_called_once_with(101)


if __name__ == '__main__':
    unittest.main(verbosity=2)
