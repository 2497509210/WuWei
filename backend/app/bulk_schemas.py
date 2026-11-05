from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
ArchiveReason = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class BulkItemSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    expected_version: int = Field(ge=1, strict=True)


class BulkItemAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: Identifier
    action: Literal["move", "archive", "restore"]
    items: list[BulkItemSelection] = Field(min_length=1, max_length=100)
    compartment_id: Identifier | None = None
    reason: ArchiveReason | None = None

    @model_validator(mode="after")
    def validate_action_fields(self) -> Self:
        ids = [item.id for item in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError("同一物品不能重复选择")
        if self.action == "archive":
            if "compartment_id" in self.model_fields_set:
                raise ValueError("归档不能指定目标隔层")
            if "reason" in self.model_fields_set and self.reason is None:
                raise ValueError("归档原因不能为 null")
        else:
            if not self.compartment_id:
                raise ValueError("移动或恢复必须指定目标隔层")
            if "reason" in self.model_fields_set:
                raise ValueError("只有归档可以填写原因")
        return self
