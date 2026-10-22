"""Mock-only regression of the recorded ME01 controls. No live SAP access."""
import sys
import unittest
import threading
import json
import re
from pathlib import Path
from types import SimpleNamespace
from datetime import date
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
import me01_source_list as engine
from me01_source_table import SourceListTable, FIELDS, sap_bool

TABLE = 'wnd[0]/usr/tblSAPLMEORTC_0205'
FIRST, LAST = '2026-10-12', '2099-12-31'
def row(supplier='', fixed=False, usage='', first='', last='', org=''):
    return {'EORD-VDATU':first,'EORD-BDATU':last,'EORD-LIFNR':supplier,'EORD-EKORG':org,
            'RM06W-FESKZ':fixed,'EORD-AUTET':usage,'EORD-NOTKZ':False,'EORD-EBELN':''}
def old(supplier='101', fixed=True, usage='1', first='03.07.2026', last='01.01.2028', org='C100'):
    return row(supplier,fixed,usage,first,last,org)

class Cell:
    def __init__(self, session, absolute, field, col, visible):
        self.session,self.absolute,self.field = session,absolute,field
        self.Id = f'{TABLE}/{"chk" if isinstance(row()[field],bool) else "ctxt"}{field}[{col},{visible}]'
        self.Changeable = (absolute,field) not in session.readonly
    def SetFocus(self): self.session.focus=self
    def get(self):
        return self.session.rows[self.absolute][self.field] if self.absolute < len(self.session.rows) else row()[self.field]
    def set(self,value):
        if not self.Changeable: raise RuntimeError('read-only')
        while self.absolute >= len(self.session.rows): self.session.rows.append(row())
        if self.field not in self.session.ignore:
            self.session.rows[self.absolute][self.field] = value
        self.session.writes.append((self.absolute,self.field,value))
        if self.session.on_write: self.session.on_write()
    Text = property(get,set)
    Selected = property(get,set)

class Collection:
    def __init__(self, values): self.values=values; self.Count=len(values)
    def __call__(self,index): return self.values[index]

class Scroll:
    def __init__(self, table): self.table=table; self.position=0
    @property
    def Maximum(self):
        return (self.table.session.scroll_maximum if self.table.session.scroll_maximum is not None
                else max(0,self.table.RowCount-self.table.session.materialized))
    @property
    def Position(self): return self.position
    @Position.setter
    def Position(self,value):
        if not 0 <= value <= self.Maximum:
            raise RuntimeError('613: The method got an invalid argument: scrollbar position')
        self.position=value
        self.table.session.scrolls.append(value)

class Table:
    def __init__(self,session,visible):
        self.session=session; self.VisibleRowCount=visible; self.VerticalScrollbar=Scroll(self); self.Id=TABLE
    @property
    def RowCount(self):
        return (2*self.VisibleRowCount-1 if self.session.virtual_growth
                else max(len(self.session.rows)+1,self.VisibleRowCount))
    @property
    def Children(self):
        cells=[]
        # Column identifiers deliberately differ from numeric visual indices.
        for visible in range(self.session.materialized):
            # Reproduces the reported terminal viewport: start=24, total=49,
            # VisibleRowCount=25, Children only row 0 (a rebuilt entry control).
            if self.session.virtual_growth and visible >= self.VisibleRowCount-self.VerticalScrollbar.Position: break
            if visible in self.session.missing_rows: continue
            absolute=self.VerticalScrollbar.Position+visible
            if self.session.virtual_growth and self.VerticalScrollbar.Position == self.VerticalScrollbar.Maximum: absolute=0
            if self.session.echo_prefix and self.VerticalScrollbar.Position > 0: absolute=visible
            for col,field in enumerate(row()):
                if (visible,field) not in self.session.missing_fields:
                    cells.append(Cell(self.session,absolute,field,col+3,visible))
        return Collection(cells)
    def GetCell(self,*args): raise RuntimeError('613: The method got an invalid argument.')

class Session:
    Busy=False
    def __init__(self,rows,visible=4,materialized=None,scroll_maximum=None):
        self.rows=rows; self.readonly=set(); self.ignore=set(); self.writes=[]; self.on_write=None
        self.materialized=visible if materialized is None else materialized
        self.scroll_maximum=scroll_maximum; self.missing_rows=set(); self.missing_fields=set()
        self.virtual_growth=False; self.scrolls=[]
        self.echo_prefix=False
        self.find_calls=0; self.bulk_calls=0
        self.table=Table(self,visible); self.save=Mock(); self.status='S'; self.popup=None
        self.focus=None; self.calendar=False; self.calendar_stuck=False
        def key(value):
            if value==4:self.calendar=True
        self.fields={'wnd[0]':SimpleNamespace(sendVKey=Mock(side_effect=key),maximize=Mock()),
                     'wnd[0]/tbar[0]/okcd':SimpleNamespace(Text=''), 'wnd[0]/usr/ctxtEORD-MATNR':SimpleNamespace(Text=''),
                     'wnd[0]/usr/ctxtEORD-WERKS':SimpleNamespace(Text='',SetFocus=Mock())}
    def findById(self,name,*args):
        self.find_calls+=1
        if name==TABLE:return self.table
        if name=='wnd[0]/tbar[0]/btn[11]':return SimpleNamespace(Press=self.save)
        if name=='wnd[0]/sbar':return SimpleNamespace(MessageType=self.status,Text='Saved' if self.status=='S' else 'Unknown')
        if name=='wnd[1]':return SimpleNamespace() if self.calendar else self.popup
        if name=='wnd[1]/usr/cntlCONTAINER/shellcont/shell':return Picker(self)
        match=re.search(r'/(ctxt|chk|txt)([^/\[]+)\[(\d+),(\d+)\]$',name)
        if match:
            _,field,col,visible=match.groups(); visible=int(visible)
            absolute=self.table.VerticalScrollbar.Position+visible
            if self.echo_prefix and self.table.VerticalScrollbar.Position>0:absolute=visible
            return Cell(self,absolute,field,int(col),visible)
        return self.fields[name]

def enable_bulk(session):
    def export(table_id,properties):
        assert table_id==TABLE and properties==[32025,32015,32000,32011,32009]
        session.bulk_calls+=1
        nodes=[]; start=session.table.VerticalScrollbar.Position
        for visible in range(session.materialized):
            if session.virtual_growth and visible>=session.table.VisibleRowCount-start:break
            if visible in session.missing_rows:continue
            absolute=visible if session.echo_prefix and start>0 else start+visible
            if session.virtual_growth and start==session.table.VerticalScrollbar.Maximum:absolute=0
            for col,field in enumerate(row()):
                if (visible,field) in session.missing_fields:continue
                cell=Cell(session,absolute,field,col+3,visible); value=cell.get()
                nodes.append({'properties':{'Id':cell.Id,'Type':'GuiCheckBox' if isinstance(value,bool) else 'GuiCTextField',
                              'Text':'' if isinstance(value,bool) else value,
                              'Checked':str(value).lower() if isinstance(value,bool) else '',
                              'Changeable':str(cell.Changeable).lower()}})
        return json.dumps({'children':[{'properties':{'Id':TABLE,'Type':'GuiTableControl'},'children':nodes}]})
    session.GetObjectTree=export

class Picker:
    def __init__(self,session):self.session=session
    @property
    def SelectionInterval(self): return ''
    @SelectionInterval.setter
    def SelectionInterval(self,value):
        from datetime import datetime
        first,last=value.split(','); assert first==last
        cell=self.session.focus
        readonly=cell.Changeable; cell.Changeable=True
        cell.Text=datetime.strptime(first,'%Y%m%d').strftime('%d.%m.%Y')
        cell.Changeable=readonly
        if not self.session.calendar_stuck:self.session.calendar=False

def adapter(session,stop=lambda:None): return SourceListTable(session,TABLE,lambda s:None,stop)

class Tests(unittest.TestCase):
    def test_bulk_no_preserves_every_old_column_only_fix_mrp_change_and_saves_once(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; enable_bulk(s); before=dict(s.rows[0])
        with patch.object(Table,'Children',new_callable=property):
            with patch.object(engine,'wait_ready'):
                self.assertTrue(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
        self.assertEqual(s.rows[0],{**before,FIELDS['fixed']:False,FIELDS['usage']:''})
        self.assertEqual(len(s.rows),2); self.assertEqual(s.rows[1][FIELDS['supplier']],'6587')
        s.save.assert_called_once(); self.assertLess(s.bulk_calls,20); self.assertLess(s.find_calls,110)
    def test_bulk_yes_preserves_other_supplier_and_repeat_does_not_duplicate(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; enable_bulk(s); before=dict(s.rows[0]); a=adapter(s)
        a.upsert('6587',True,FIRST,LAST,'C100'); self.assertEqual(s.rows[0],before)
        s.writes.clear(); self.assertFalse(a.upsert('6587',True,FIRST,LAST,'C100'))
        self.assertEqual(s.writes,[]); self.assertEqual(len(s.rows),2)
    def test_bulk_retains_other_columns_with_direct_date_entry(self):
        s=Session([old()]); s.rows[0]['EORD-EBELN']='4601234567'; enable_bulk(s)
        adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.rows[0]['EORD-EBELN'],'4601234567')
        self.assertEqual(s.rows[1][FIELDS['from']],'12.10.2026')
        s.fields['wnd[0]'].sendVKey.assert_not_called()
        self.assertTrue(all(field in {FIELDS['fixed'],FIELDS['usage']} for absolute,field,_ in s.writes if absolute==0))
    def test_bulk_and_legacy_read_all_fields_identically_and_checkbox_false_is_not_truthy_string(self):
        s=Session([old(),old('6587',False,'2')]); a=adapter(s)
        _,legacy=a.page(0); expected={i:a.values(c) for i,c in legacy.items()}
        enable_bulk(s); a.bulk_supported=None; _,bulk=a.page(0)
        self.assertEqual({i:a.values(c) for i,c in bulk.items()},expected)
        self.assertTrue(sap_bool('true')); self.assertFalse(sap_bool('false'))
        for value in ('',None,'anything'):
            with self.assertRaises(RuntimeError):sap_bool(value)
    def test_bulk_bad_json_or_missing_boolean_fails_before_write_without_legacy_fallback(self):
        s=Session([old()]); enable_bulk(s); export=s.GetObjectTree
        for mode in ('json','checked','readonly','foreign'):
            def bad(*args):
                if mode=='json':return '{'
                raw=export(*args)
                if mode=='checked':return raw.replace('"Checked": "true"','"Checked": ""')
                if mode=='readonly':return raw.replace('"Changeable": "true"','"Changeable": "false"')
                return raw.replace(TABLE,'wnd[0]/usr/WRONG_TABLE')
            s.GetObjectTree=bad
            with self.assertRaises(Exception):adapter(s).upsert('6587',False,FIRST,LAST,'C100')
            self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_bulk_multi_page_reads_late_suppliers_and_still_clears_only_fix_mrp(self):
        s=Session([old(str(i)) for i in range(55)],visible=26,materialized=25); enable_bulk(s)
        adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(len(s.rows),56)
        self.assertTrue(all(not r[FIELDS['fixed']] and r[FIELDS['usage']]=='' for r in s.rows[:55]))
    def test_bulk_metrics_confirm_save_and_preservation_audit_without_changing_result(self):
        s=Session([old()]); enable_bulk(s); diagnostics={}
        with patch.object(engine,'wait_ready'):
            self.assertTrue(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100',diagnostics))
        self.assertTrue(diagnostics['savedConfirmed']); self.assertGreater(diagnostics['reader']['bulkReads'],0)
        self.assertEqual(diagnostics['reader']['legacyPages'],0)
        self.assertEqual(diagnostics['existingRowsBefore'][0][FIELDS['supplier']],'101')
        self.assertEqual(diagnostics['plannedRowsAfter'][0][FIELDS['supplier']],'101')
        self.assertFalse(diagnostics['plannedRowsAfter'][0][FIELDS['fixed']])
        self.assertEqual(diagnostics['plannedRowsAfter'][0][FIELDS['usage']],'')
        self.assertGreaterEqual(diagnostics['sapTotalSeconds'],0); json.dumps(diagnostics)
    def test_cached_boundary_never_caches_old_field_values_or_hides_removal(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; enable_bulk(s); a=adapter(s); a.snapshot()
        s.rows[0]['EORD-EBELN']='CHANGED'; actual,_=a.snapshot()
        self.assertEqual(actual[0]['EORD-EBELN'],'CHANGED')
        s.rows=[]; actual,_=a.snapshot(); self.assertEqual(actual,{})
    def test_no_creates_second_row_and_clears_other_fix_and_mrp_without_deleting(self):
        s=Session([old()]); original=dict(s.rows[0])
        self.assertTrue(adapter(s).upsert('6587',False,FIRST,LAST,'C100'))
        self.assertEqual(len(s.rows),2)
        self.assertEqual(s.rows[0],{**original,'RM06W-FESKZ':False,'EORD-AUTET':''})
        self.assertEqual(s.rows[1]['EORD-LIFNR'],'6587')
        self.assertEqual(s.rows[1]['EORD-EKORG'],'C100')
        self.assertEqual(s.rows[1]['EORD-VDATU'],'12.10.2026')
        self.assertEqual(s.rows[1]['EORD-BDATU'],'31.12.2099')
        self.assertTrue(s.rows[1]['RM06W-FESKZ']); self.assertEqual(s.rows[1]['EORD-AUTET'],'1')
    def test_yes_creates_target_and_preserves_all_old_values(self):
        s=Session([old(),old('OTHER',False,'2')]); before=[dict(r) for r in s.rows]
        adapter(s).upsert('6587',True,FIRST,LAST,'C100')
        self.assertEqual(s.rows[:2],before)
    def test_start_date_is_written_directly_without_calendar(self):
        s=Session([old()])
        adapter(s).upsert('6587',True,FIRST,LAST,'C100')
        self.assertEqual(s.rows[1][FIELDS['from']],'12.10.2026')
        s.fields['wnd[0]'].sendVKey.assert_not_called()
        self.assertEqual([v for _,f,v in s.writes if f==FIELDS['from']],['12.10.2026'])
    def test_readonly_start_date_keeps_all_rows_and_does_not_open_calendar(self):
        s=Session([old()]); s.readonly.add((1,FIELDS['from'])); before=dict(s.rows[0])
        with self.assertRaisesRegex(RuntimeError,'read-only'): adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.rows[0],before); s.save.assert_not_called()
        self.assertEqual(s.writes,[]); s.fields['wnd[0]'].sendVKey.assert_not_called()
    def test_ignored_start_date_fails_readback_before_old_fix_mrp_changes(self):
        s=Session([old()]); s.ignore.add(FIELDS['from']); before=dict(s.rows[0])
        with self.assertRaisesRegex(RuntimeError,'changed during review|readback'): adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.rows[0],before); s.save.assert_not_called()
        s.fields['wnd[0]'].sendVKey.assert_not_called()
    def test_explicit_custom_start_date_is_respected_and_formatted(self):
        s=Session([]); enable_bulk(s)
        adapter(s).upsert('6587',False,'2026-11-03',LAST,'C100')
        self.assertEqual(s.rows[0][FIELDS['from']],'03.11.2026')
        s.fields['wnd[0]'].sendVKey.assert_not_called()
    def test_empty_source_list_creates_first_row(self):
        s=Session([]); adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(len(s.rows),1); self.assertTrue(s.rows[0]['RM06W-FESKZ'])
    def test_repeat_uses_covering_target_no_duplicate_and_no_save(self):
        s=Session([old(),old('000006587',True,'1','09.10.2026','31.12.2099')])
        a=adapter(s)
        self.assertTrue(a.upsert('6587',False,FIRST,LAST,'C100'))
        count=len(s.rows); s.writes.clear()
        self.assertFalse(a.upsert('6587',False,'2026-10-13',LAST,'C100'))
        self.assertEqual(len(s.rows),count); self.assertEqual(s.writes,[])
    def test_no_clears_expired_and_future_fix_and_mrp_but_keeps_dates(self):
        s=Session([old(first='01.01.2000',last='31.12.2001'),old('FUTURE',True,'2','01.01.2098','31.12.2099')])
        dates=[(r['EORD-VDATU'],r['EORD-BDATU']) for r in s.rows]
        adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual([(r['EORD-VDATU'],r['EORD-BDATU']) for r in s.rows[:2]],dates)
        self.assertTrue(all(not r['RM06W-FESKZ'] and r['EORD-AUTET']=='' for r in s.rows[:2]))
    def test_target_already_fixed_still_switches_other_usage(self):
        s=Session([old(fixed=False,usage='2'),old('6587',True,'1','01.01.2020','31.12.2099')])
        self.assertTrue(adapter(s).upsert('6587',False,FIRST,LAST,'C100'))
        self.assertEqual(s.rows[0]['EORD-AUTET'],'')
    def test_duplicate_or_overlapping_target_stops_without_writes(self):
        for rows in [[old('6587',last='31.12.2099'),old('6587',last='31.12.2099')],[old('6587')]]:
            s=Session(rows)
            with self.assertRaisesRegex(RuntimeError,'Multiple|overlapping'): adapter(s).upsert('6587',False,FIRST,LAST,'C100')
            self.assertEqual(s.writes,[])
    def test_unsupported_date_or_incomplete_row_stops_without_writes(self):
        for rows in [[old(first='10/12/2026')],[row(first='12.10.2026',last='31.12.2099')]]:
            s=Session(rows)
            with self.assertRaises(RuntimeError): adapter(s).upsert('6587',False,FIRST,LAST,'C100')
            self.assertEqual(s.writes,[])
    def test_readonly_other_mrp_detected_before_creating_target(self):
        s=Session([old()]); s.readonly.add((0,FIELDS['usage']))
        with self.assertRaisesRegex(RuntimeError,'read-only'): adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(len(s.rows),1); self.assertEqual(s.writes,[])
    def test_readback_rejects_ignored_mrp_write(self):
        s=Session([old()]); s.ignore.add(FIELDS['usage'])
        with self.assertRaisesRegex(RuntimeError,'readback'): adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        s.save.assert_not_called()
    def test_last_page_clamping_and_reordered_columns(self):
        s=Session([old(str(i)) for i in range(6)],visible=4)
        adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(len(s.rows),7)
        self.assertTrue(all(not r[FIELDS['fixed']] and not r[FIELDS['usage']] for r in s.rows[:6]))
        self.assertTrue(s.rows[6][FIELDS['fixed']])
    def test_reported_row_26_without_controls_does_not_block_add_and_save(self):
        s=Session([old()],visible=26,materialized=25)
        with patch.object(engine,'wait_ready'):
            self.assertTrue(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
        s.save.assert_called_once()
        self.assertEqual(s.rows[1][FIELDS['supplier']],'6587')
        self.assertFalse(s.rows[0][FIELDS['fixed']]); self.assertEqual(s.rows[0][FIELDS['usage']],'')
    def test_virtual_tail_at_scroll_end_requires_readable_empty_tail(self):
        s=Session([old()],visible=26,materialized=25,scroll_maximum=0)
        adapter(s).upsert('6587',True,FIRST,LAST,'C100')
        self.assertEqual(s.rows[1][FIELDS['supplier']],'6587')
        s=Session([old(str(i)) for i in range(25)],visible=26,materialized=25,scroll_maximum=0)
        with self.assertRaisesRegex(RuntimeError,'unread tail.*RowCount=26.*controlRows='):
            adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_clipped_viewport_does_not_skip_suppliers_on_later_pages(self):
        s=Session([old(str(i)) for i in range(55)],visible=26,materialized=25)
        adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(len(s.rows),56)
        self.assertTrue(all(not r[FIELDS['fixed']] and r[FIELDS['usage']]=='' for r in s.rows[:55]))
        self.assertEqual(s.rows[55][FIELDS['supplier']],'6587')
    def test_clipped_viewport_finds_existing_target_on_later_page_without_duplicate(self):
        s=Session([old(str(i)) for i in range(25)]+[old('6587',True,'1',first='01.01.2020',last='31.12.2099')],
                  visible=26,materialized=25)
        before=[dict(r) for r in s.rows]
        self.assertFalse(adapter(s).upsert('6587',True,FIRST,LAST,'C100'))
        self.assertEqual(s.rows,before); self.assertEqual(s.writes,[])
    def test_blank_inside_table_does_not_hide_later_supplier(self):
        s=Session([old(),row()]+[old(str(i)) for i in range(30)],visible=26,materialized=25)
        adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(len(s.rows),32)
        self.assertEqual(s.rows[1][FIELDS['supplier']],'6587')
        self.assertTrue(all(not r[FIELDS['fixed']] and r[FIELDS['usage']]=='' for r in [s.rows[0],*s.rows[2:]]))
    def test_native_metadata_49_rows_probes_real_empty_boundary_instead_of_maximum(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24); s.virtual_growth=True
        a=adapter(s); rows,blanks=a.snapshot()
        self.assertEqual(set(rows),{0}); self.assertIn(24,blanks)
        self.assertEqual(s.table.VerticalScrollbar.Position,1); self.assertEqual(s.scrolls,[1])
        self.assertIn('Confirmed empty entry boundary',a.read_trace[-1])
    def test_real_me01_virtual_append_extent_adds_second_row_and_saves_without_padding_scroll(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24); s.virtual_growth=True
        with patch.object(engine,'wait_ready'):
            self.assertTrue(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
        self.assertTrue(s.scrolls); self.assertTrue(all(position in (0,1) for position in s.scrolls)); s.save.assert_called_once()
        self.assertEqual(len(s.rows),2); self.assertTrue(s.rows[1][FIELDS['fixed']])
        self.assertEqual(s.rows[1][FIELDS['usage']],'1')
        self.assertFalse(s.rows[0][FIELDS['fixed']]); self.assertEqual(s.rows[0][FIELDS['usage']],'')
    def test_real_me01_existing_target_rechecks_with_boundary_probe_but_no_save(self):
        s=Session([old(fixed=False,usage=''),old('6587',True,'1',first='12.10.2026',last='31.12.2099')],
                  visible=25,materialized=25,scroll_maximum=24); s.virtual_growth=True
        with patch.object(engine,'wait_ready'), patch.object(engine,'open_me01') as navigate:
            self.assertFalse(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
        navigate.assert_called_once_with(s)
        self.assertEqual(s.writes,[]); self.assertTrue(all(position in (0,1) for position in s.scrolls)); s.save.assert_not_called()
    def test_hub_skips_any_existing_target_without_changing_fix_mrp_dates_or_other_rows(self):
        for dual in (True, False):
            for targets in [[old('000006587',False,'',first='01.01.2000',last='01.01.2001',org='C200')],
                            [old('6587'),old('6587',False,'2',last='31.12.2099')]]:
                with self.subTest(dual=dual, targets=targets):
                    s=Session([old(),*targets]); before=[dict(r) for r in s.rows]
                    a=adapter(s)
                    self.assertFalse(a.upsert('6587',dual,FIRST,LAST,'C100',skip_existing=True))
                    self.assertEqual(a.skip_reason,'SOURCE_EXISTS')
                    self.assertEqual(s.rows,before); self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_hub_finds_target_on_later_page_and_skips_without_writes(self):
        s=Session([old(str(i)) for i in range(25)]+[old('000006587',False,'2')],visible=26,materialized=25)
        before=[dict(r) for r in s.rows]; diagnostics={}
        with patch.object(engine,'wait_ready'), patch.object(engine,'open_me01') as navigate:
            self.assertFalse(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100',diagnostics))
        navigate.assert_called_once_with(s)
        self.assertEqual(diagnostics['skipReason'],'SOURCE_EXISTS')
        self.assertEqual(s.rows,before); self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_hub_missing_target_still_applies_dual_rules_and_preserves_other_records(self):
        for dual in (True, False):
            s=Session([old()]); before=dict(s.rows[0])
            with patch.object(engine,'wait_ready'):
                self.assertTrue(engine.maintain_material(s,'20503551','6587',dual,FIRST,LAST,'C100'))
            self.assertEqual(len(s.rows),2)
            self.assertEqual(s.rows[1][FIELDS['supplier']],'6587')
            self.assertTrue(s.rows[1][FIELDS['fixed']]); self.assertEqual(s.rows[1][FIELDS['usage']],'1')
            if dual:self.assertEqual(s.rows[0],before)
            else:
                self.assertFalse(s.rows[0][FIELDS['fixed']]); self.assertEqual(s.rows[0][FIELDS['usage']],'')
                self.assertEqual(s.rows[0][FIELDS['from']],before[FIELDS['from']])
                self.assertEqual(s.rows[0][FIELDS['to']],before[FIELDS['to']])
            s.save.assert_called_once()
    def test_real_me01_yes_keeps_other_source_and_avoids_virtual_scroll(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24); s.virtual_growth=True
        before=dict(s.rows[0]); adapter(s).upsert('6587',True,FIRST,LAST,'C100')
        self.assertEqual(s.rows[0],before); self.assertTrue(all(position in (0,1) for position in s.scrolls))
    def test_native_padding_still_rejects_changed_overlap_before_any_business_write(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24); s.virtual_growth=True
        a=adapter(s); original_page=a.page
        def changed_page(position):
            result=original_page(position)
            if position==1:
                while len(s.rows)<25:s.rows.append(row())
                s.rows[24][FIELDS['usage']]='2'
            return result
        with patch.object(a,'page',side_effect=changed_page):
            with self.assertRaisesRegex(RuntimeError,'changed during paging.*Before=.*After=.*pages='):
                a.upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_reported_row_two_blank_to_101_echo_is_verified_at_top_then_no_saves_once(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; before=dict(s.rows[0])
        with patch.object(engine,'wait_ready'):
            self.assertTrue(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
        s.save.assert_called_once(); self.assertEqual(len(s.rows),2)
        self.assertEqual(s.rows[0],{**before,FIELDS['fixed']:False,FIELDS['usage']:''})
        self.assertEqual(s.rows[1][FIELDS['supplier']],'6587')
        self.assertTrue(s.rows[1][FIELDS['fixed']]); self.assertEqual(s.rows[1][FIELDS['usage']],'1')
        self.assertTrue(all(position in (0,1) for position in s.scrolls))
    def test_echo_yes_preserves_other_supplier_and_repeated_target_never_duplicates(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; before=dict(s.rows[0]); a=adapter(s)
        self.assertTrue(a.upsert('6587',True,FIRST,LAST,'C100'))
        self.assertEqual(s.rows[0],before); s.writes.clear()
        self.assertFalse(a.upsert('6587',True,FIRST,LAST,'C100'))
        self.assertEqual(len(s.rows),2); self.assertEqual(s.writes,[])
    def test_echo_cannot_hide_real_changes_during_return_to_top(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; a=adapter(s); original=a.page
        def changed(position):
            if position==0 and s.scrolls:
                s.rows[0][FIELDS['usage']]='2'
            return original(position)
        with patch.object(a,'page',side_effect=changed):
            with self.assertRaisesRegex(RuntimeError,'echo could not be verified'):
                a.upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_partial_echo_with_an_unseen_supplier_is_not_accepted(self):
        s=Session([old()],visible=25,materialized=25,scroll_maximum=24)
        s.virtual_growth=True; s.echo_prefix=True; a=adapter(s); original=a.page
        def extra_supplier(position):
            result=original(position)
            if position==1:
                while len(s.rows)<24:s.rows.append(row())
                s.rows[23]=old('UNSEEN')
            return result
        with patch.object(a,'page',side_effect=extra_supplier):
            with self.assertRaisesRegex(RuntimeError,'changed during paging'):
                a.upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_stuck_scrollbar_stops_without_mutation(self):
        s=Session([old(str(i)) for i in range(30)],visible=26,materialized=25)
        class StuckScroll:
            Maximum=6
            Position=property(lambda _self:0,lambda _self,_value:None)
        s.table.VerticalScrollbar=StuckScroll()
        with self.assertRaisesRegex(RuntimeError,'paging made no progress'):
            adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_interior_missing_row_or_partial_row_fails_before_write(self):
        s=Session([old()],visible=26,materialized=25); s.missing_rows.add(12)
        with self.assertRaisesRegex(RuntimeError,'gap.*VisibleRowCount=26'):
            adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[])
        s=Session([old()],visible=26,materialized=25); s.missing_fields.add((24,FIELDS['usage']))
        with self.assertRaisesRegex(RuntimeError,'controls missing'):
            adapter(s).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[])
    def test_missing_controls_fail_before_mutation(self):
        s=Session([old()]); a=adapter(s); values=a.page(0)[1][0]; del values[FIELDS['to']]
        with self.assertRaisesRegex(RuntimeError,'controls missing'): a.values(values)
        self.assertEqual(s.writes,[])
    def test_no_verified_empty_row_stops_without_changes(self):
        s=Session([old()]); a=adapter(s); rows,_=a.snapshot()
        with patch.object(a,'snapshot',return_value=(rows,{})):
            with self.assertRaisesRegex(RuntimeError,'No verified empty'): a.upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[])
    def test_material_changed_after_navigation_stops_before_row_write(self):
        s=Session([old()])
        def wrong_material(_session): s.fields['wnd[0]/usr/ctxtEORD-MATNR'].Text='WRONG'
        with patch.object(engine,'wait_ready',side_effect=wrong_material):
            with self.assertRaisesRegex(RuntimeError,'material/Plant changed'):
                engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[]); s.save.assert_not_called()
    def test_stop_before_write_changes_nothing_but_after_write_finishes_plan(self):
        from hub_user_interaction import HubStopped
        s=Session([old()]); stop=threading.Event(); stop.set()
        def check():
            if stop.is_set():raise HubStopped()
        with self.assertRaises(HubStopped): adapter(s,check).upsert('6587',False,FIRST,LAST,'C100')
        self.assertEqual(s.writes,[])
        stop.clear(); s.on_write=stop.set
        adapter(s,check).upsert('6587',False,FIRST,LAST,'C100')
        self.assertFalse(s.rows[0][FIELDS['fixed']]); self.assertTrue(s.rows[1][FIELDS['fixed']])
    def test_saved_once_and_matching_state_does_not_save_again(self):
        s=Session([old()])
        with patch.object(engine,'wait_ready'):
            self.assertTrue(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
            self.assertFalse(engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100'))
        s.save.assert_called_once()
    def test_unknown_save_is_reported_with_stage_and_never_replayed(self):
        s=Session([old()]); s.status='W'
        with patch.object(engine,'wait_ready'):
            with self.assertRaisesRegex(RuntimeError,r'\[Save Source List\].*no confirmed success'):
                engine.maintain_material(s,'20503551','6587',False,FIRST,LAST,'C100')
        s.save.assert_called_once()

if __name__=='__main__':unittest.main()
