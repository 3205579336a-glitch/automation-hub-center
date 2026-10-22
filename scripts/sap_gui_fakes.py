"""Offline COM-shaped fixtures. No SAP/Windows automation imports."""
from types import SimpleNamespace
from unittest.mock import Mock


class Collection:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def Count(self):
        return len(self.values)

    def __call__(self, index):
        return self.values[index]


def session(*, system='VCE', client='100', user='TEST_ONLY', transaction='SESSION_MANAGER', busy=False, popup=False):
    info = SimpleNamespace(SystemName=system, Client=client, User=user, Transaction=transaction)
    main = SimpleNamespace(Handle=100, Text='SAP Easy Access', Maximize=Mock())
    modal = SimpleNamespace(Handle=101, Text='SAP dialog') if popup else None
    return SimpleNamespace(Info=info, Busy=busy,
        FindById=Mock(side_effect=lambda name, *args: main if name == 'wnd[0]' else modal if name == 'wnd[1]' else None))


def connection(sessions=(), label='VCE - One Digital Core [949]', *, disabled=False):
    collection = Collection(sessions)
    return SimpleNamespace(Description=label, Name=label, Children=collection, Sessions=collection, DisabledByServer=disabled)


def application(connections=()):
    collection = Collection(connections)
    return SimpleNamespace(Children=collection, Connections=collection, OpenConnection=Mock())
