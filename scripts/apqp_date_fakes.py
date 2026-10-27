"""Offline-only reusable SAP objects for date API/desktop smoke tests."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('apqp_discovery_test_fakes', Path(__file__).with_name('test-apqp-date-discovery.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
legacy = base.legacy


class DateSession(base.Session):
    def __init__(self, count=25, state='home', system='VCE'):
        super().__init__(state=state, system=system)
        self.grid.ColumnOrder = ['APQPNO', 'MATNR', 'LIFNR', 'WERKS', 'PSPID_1', 'SD']
        self.grid.rows = [[str(2000000000 + index), str(10000000 + index), '0041889', 'C100', '775773', 'EE00221'] for index in range(count)]
        self.grid.VisibleRowCount = 10
        self.grid.virtualized = True
        self.values = {row[0]: ['', '20.10.2026', '25.12.2026', ''] for row in self.grid.rows}
        self.unknown_return_popup = False

    def execute(self):
        if self.state == 'grid':
            number = self.grid.rows[int(self.grid.SelectedRows)][0]
            for field, value in zip(base.DATE_FIELDS, self.values[number]):
                if field.control_id in self.dates:
                    self.dates[field.control_id].text = value
        super().execute()

    def back(self):
        self.calls.append(('back', self.state))
        if self.unknown_return_popup:
            self.popup = True
        else:
            self.state = 'grid'

    def find(self, identifier, required=True):
        if identifier == legacy.ID_BACK:
            return SimpleNamespace(Press=self.back)
        return super().find(identifier, required)


def application(*sessions):
    return base.application(*sessions)


def enable_bulk_dates(session):
    """Offline equivalent of the existing SAP GetObjectTree JSON protocol."""
    session.bulk_reads = 0
    def export(root, properties):
        assert properties == [32025, 32015, 32000, 32009]
        assert root == base.DATE_FIELDS[0].control_id.rsplit('/', 1)[0]
        assert session.state == 'detail'
        session.bulk_reads += 1
        return json.dumps({'properties': {'Id': session.Id + '/' + root}, 'children': [
            {'properties': {'Id': session.Id + '/' + field.control_id, 'Type': 'GuiCTextField',
                            'Text': session.dates[field.control_id].text,
                            'Changeable': str(session.dates[field.control_id].Changeable).lower()}}
            for field in base.DATE_FIELDS if field.control_id in session.dates]})
    session.GetObjectTree = export
