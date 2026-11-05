from __future__ import annotations

import json
import uuid

from ..db import now_iso


ITEM_QUERY = """
    SELECT i.*, cp.name AS compartment_name, c.id AS container_id,
           c.name AS container_name, r.id AS room_id, r.name AS room_name,
           f.name AS floor_name
    FROM items i
    LEFT JOIN compartments cp ON cp.id = i.compartment_id
    LEFT JOIN containers c ON c.id = cp.container_id
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN floors f ON f.id = r.floor_id
"""


def find_item(connection, item_id: str, household_id: str):
    return connection.execute(ITEM_QUERY + " WHERE i.id=? AND i.household_id=?", (item_id, household_id)).fetchone()


def find_compartment(connection, compartment_id: str | None, household_id: str):
    return connection.execute(
        """SELECT cp.*, cp.name AS compartment_name,
                  c.name AS container_name, r.name AS room_name, f.name AS floor_name
           FROM compartments cp JOIN containers c ON c.id=cp.container_id
           JOIN rooms r ON r.id=c.room_id JOIN floors f ON f.id=r.floor_id
           WHERE cp.id=? AND f.household_id=?""", (compartment_id, household_id),
    ).fetchone()


def location_path(row) -> list[str]:
    if "archived_at" in row.keys() and row["archived_at"]:
        return json.loads(row["archived_location_json"] or "[]")
    return [row[key] for key in ("floor_name", "room_name", "container_name", "compartment_name") if row[key] is not None]


def record_event(connection, *, item_id: str, event_type: str, user: dict,
                 item_version: int, from_id: str | None, to_id: str | None,
                 from_path: list[str] | None, to_path: list[str] | None,
                 changes: dict | None = None, created_at: str | None = None) -> str:
    """Append to the caller's transaction; never commit a partial item change."""
    event_id = str(uuid.uuid4())
    connection.execute(
        """INSERT INTO item_events
           (id,item_id,from_compartment_id,to_compartment_id,user_id,created_at,
            event_type,actor_name,from_path_json,to_path_json,changes_json,item_version,legacy)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)""",
        (event_id, item_id, from_id, to_id, user["id"], created_at or now_iso(),
         event_type, user["display_name"],
         json.dumps(from_path, ensure_ascii=False) if from_path is not None else None,
         json.dumps(to_path, ensure_ascii=False) if to_path is not None else None,
         json.dumps(changes or {}, ensure_ascii=False), item_version),
    )
    return event_id


def record_change(connection, before, after, event_type: str, user: dict,
                  changes: dict | None = None):
    return record_event(
        connection, item_id=after["id"], event_type=event_type, user=user,
        item_version=after["version"],
        from_id=before["compartment_id"] if before is not None else None,
        to_id=after["compartment_id"],
        from_path=location_path(before) if before is not None else None,
        to_path=None if event_type == "archive" else location_path(after),
        changes=changes, created_at=after["updated_at"],
    )


def can_undo_move(connection, item, event, household_id: str, latest_id: str | None) -> bool:
    if (item["archived_at"] or event["legacy"] or event["event_type"] != "move"
            or event["id"] != latest_id or event["item_version"] != item["version"]
            or event["to_compartment_id"] != item["compartment_id"]
            or not event["from_compartment_id"]):
        return False
    return find_compartment(connection, event["from_compartment_id"], household_id) is not None


def latest_event_id(connection, item_id: str) -> str | None:
    row = connection.execute(
        "SELECT id FROM item_events WHERE item_id=? ORDER BY item_version DESC, created_at DESC, rowid DESC LIMIT 1",
        (item_id,),
    ).fetchone()
    return row["id"] if row else None
