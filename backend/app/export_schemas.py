from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

ExportId = Annotated[str, StringConstraints(min_length=1, max_length=100)]


class InventoryExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["csv", "json"]
    scope: Literal["filtered", "selected", "all"]
    status: Literal["active", "archived"] | None = None
    q: str | None = Field(default=None, max_length=4000)
    compartment_id: ExportId | None = None
    room_id: ExportId | None = None
    location_status: Literal["confirmed", "missing"] | None = None
    ids: list[ExportId] | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def scope_fields(self):
        supplied = self.model_fields_set
        if self.scope == "filtered":
            if "ids" in supplied:
                raise ValueError("筛选导出不能包含选中 ID")
            if any(getattr(self, name) is None for name in ("status", "q", "compartment_id", "room_id", "location_status") if name in supplied):
                raise ValueError("筛选字段不能为 null")
        else:
            if supplied.intersection({"status", "q", "compartment_id", "room_id", "location_status"}):
                raise ValueError("所选和全部导出不能包含其他筛选")
            if self.scope == "selected":
                if not self.ids or len(set(self.ids)) != len(self.ids):
                    raise ValueError("请选择 1–100 个不同的物品")
            elif "ids" in supplied:
                raise ValueError("全部导出不能包含选中 ID")
        return self
