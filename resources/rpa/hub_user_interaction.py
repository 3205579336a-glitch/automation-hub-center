"""Small Hub-only stdin pause protocol; no SAP business logic or credentials."""
import json
import os
import queue
import sys
import threading
import uuid


class HubStopped(BaseException):
    pass


class HubUserInteraction:
    def __init__(self, automation, emit, stop_event=None):
        self.automation = automation
        self.emit = emit
        self.run_id = os.environ.get('HUB_RUN_ID', '')
        self.stop_event = stop_event or threading.Event()
        self.responses = queue.Queue()
        self.active_request_id = ""

    def start_listener(self):
        threading.Thread(target=self.listen, daemon=True).start()

    def listen(self):
        for line in sys.stdin:
            if line.strip() == 'cancel':
                self.stop_event.set()
                continue
            try:
                value = json.loads(line)
                if isinstance(value, dict) and value.get('runId') == self.run_id and value.get('requestId') == self.active_request_id:
                    if value.get('action') == 'stop':
                        self.stop_event.set()
                    else:
                        self.responses.put(value)
            except ValueError:
                pass

    def wait(self, stage, issue, issue_zh, verify=None, **context):
        message = issue
        while True:
            if self.stop_event.is_set():
                raise HubStopped()
            request_id = str(uuid.uuid4())
            self.active_request_id = request_id
            request = dict(automation=self.automation, runId=self.run_id, requestId=request_id,
                           state='WAITING_FOR_USER', allowedActions=['continue', 'stop'] if verify else ['stop'],
                           message=message, issueSummary=issue, issueSummaryZh=issue_zh,
                           step=stage, recoveryPoint=stage, **context)
            self.emit('interaction', interaction=request)
            while not self.stop_event.is_set():
                try:
                    response = self.responses.get(timeout=0.15)
                    if response.get('requestId') == request_id and response.get('action') == 'continue' and verify:
                        break
                except queue.Empty:
                    pass
            if self.stop_event.is_set():
                raise HubStopped()
            self.emit('recovering', requestId=request_id)
            try:
                result = verify(response.get('values', {})) if context.get('fields') else verify()
                if self.stop_event.is_set():
                    raise HubStopped()
                self.active_request_id = ''
                self.emit('interaction-resolved', requestId=request_id)
                return result
            except Exception as error:
                message = 'The issue is still present. ' + str(error)


def session_identity(session):
    info = session.Info
    identity = (str(session.Id), str(info.SystemName), str(info.Client), str(info.User))
    if not all(identity):
        raise RuntimeError('The signed-in SAP session could not be verified.')
    return identity


def verify_session(session, expected):
    if session_identity(session) != expected or session.Busy:
        raise RuntimeError('Return to the original signed-in, idle SAP window.')
    try:
        popup = session.findById('wnd[1]', False)
    except Exception:
        popup = None
    if popup is not None:
        raise RuntimeError('Close the SAP dialog before checking again.')
    bar = session.findById('wnd[0]/sbar')
    if str(bar.MessageType).upper() in {'E', 'A'}:
        raise RuntimeError(str(bar.Text) or 'SAP still reports an error.')
