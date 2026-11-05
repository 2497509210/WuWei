from __future__ import annotations

import csv
import io
import json
import unicodedata

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..db import connect, now_iso
from ..export_schemas import InventoryExportIn
from ..services.history import find_compartment, location_path
from ..services.item_query import iter_items
from ..session import require_session

router = APIRouter(prefix="/api")
MAX_EXPORT_ITEMS = 10_000


def _error(status: int, code: str, message: str):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}},
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def _export_item(row):
    # An explicit allowlist prevents future private item columns from entering a file.
    return {
        "id": row["id"], "name": row["name"], "aliases": json.loads(row["aliases_json"]),
        "quantity": row["quantity"], "notes": row["notes"], "location_path": location_path(row),
        "compartment_id": row["compartment_id"], "container_id": row["container_id"], "room_id": row["room_id"],
        "status": "archived" if row["archived_at"] else "active", "location_status": row["location_status"],
        "last_confirmed_at": row["last_confirmed_at"], "archived_at": row["archived_at"],
        "archive_reason": row["archive_reason"], "created_at": row["created_at"], "updated_at": row["updated_at"],
        "version": row["version"], "has_photo": bool(row["photo_path"]),
    }


def _csv_text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        return value
    # Spreadsheet parsers can skip whitespace/control prefixes before a formula.
    stripped = value
    while stripped and (stripped[0].isspace() or unicodedata.category(stripped[0]) in {"Cc", "Cf", "Zl", "Zp", "Zs"}):
        stripped = stripped[1:]
    if (stripped and stripped[0] in "=+-@") or value.startswith(("\t", "\r", "\n")):
        return "'" + value
    return value


def _csv_content(items: list[dict]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writerow(["ID", "名称", "别名", "数量", "备注", "位置路径", "状态", "位置确认状态", "最后确认时间",
                     "归档原因", "归档时间", "创建时间", "更新时间", "版本", "有照片", "房间ID", "容器ID", "隔层ID"])
    for item in items:
        writer.writerow([_csv_text(value) for value in [
            item["id"], item["name"], "、".join(item["aliases"]), item["quantity"], item["notes"],
            " / ".join(item["location_path"]), "已归档" if item["status"] == "archived" else "在用",
            "未找到" if item["location_status"] == "missing" else "已确认", item["last_confirmed_at"],
            item["archive_reason"], item["archived_at"], item["created_at"], item["updated_at"], item["version"],
            "是" if item["has_photo"] else "否", item["room_id"], item["container_id"], item["compartment_id"],
        ]])
    return output.getvalue().encode("utf-8-sig")


@router.post("/inventory/export")
def export_inventory(payload: InventoryExportIn, request: Request):
    connection = connect(request.app.state.db_path)
    try:
        connection.execute("BEGIN")
        user = require_session(connection, request)
        if payload.scope == "filtered" and payload.compartment_id and not find_compartment(connection, payload.compartment_id, user["household_id"]):
            return _error(404, "compartment_not_found", "隔层不存在")
        rows = iter_items(
            connection, user["household_id"],
            status=(payload.status or "active") if payload.scope == "filtered" else None,
            q=(payload.q or "") if payload.scope == "filtered" else "",
            compartment_id=payload.compartment_id if payload.scope == "filtered" else None,
            ids=payload.ids if payload.scope == "selected" else None,
        )
        items = []
        for row in rows:
            if len(items) == MAX_EXPORT_ITEMS:
                return _error(413, "export_limit_exceeded", "清单超过 10000 条，请缩小筛选范围后导出")
            items.append(_export_item(row))
        if payload.scope == "selected" and len(items) != len(payload.ids):
            return _error(404, "item_not_found", "所选物品不存在或无权访问，请刷新后重新选择")
        exported_at = now_iso()
        if payload.format == "json":
            content = json.dumps({"schema_version": 1, "exported_at": exported_at, "item_count": len(items),
                                  "scope": payload.scope, "items": items}, ensure_ascii=False, indent=2).encode("utf-8")
            media_type = "application/json"
        else:
            content = _csv_content(items)
            media_type = "text/csv; charset=utf-8"
        return Response(content, media_type=media_type, headers={
            "Content-Disposition": f'attachment; filename="wuwei-inventory.{payload.format}"',
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        })
    finally:
        connection.close()
