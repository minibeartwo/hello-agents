"""Reviewable, optimistic file changes with persistent before/after checkpoints."""
from __future__ import annotations

import difflib
import json
import os
import stat
import tempfile
from pathlib import Path

from .store import Store, identifier, now
from .skills import ANNOTATION_SKILL, validate_annotation_change
from .workspace import Conflict, MAX_FILE, Workspace, digest


class Patches:
    def __init__(self, store: Store):
        self.store = store

    def propose(self, task: dict, changes: list[dict]) -> dict:
        if not isinstance(changes, list):
            raise ValueError("changes 必须是 JSON 数组（列表），每项包含 path、base_hash 及 content 或 edits。")
        if not 1 <= len(changes) <= 5:
            raise ValueError("一次补丁需要包含 1–5 个文件。")
        workspace = Workspace(self.store.one("workspaces", task["workspace_id"])["root"],
                              include_build_sources=task.get("skill") == ANNOTATION_SKILL)
        prepared, seen = [], set()
        total = 0
        for index, change in enumerate(changes):
            if not isinstance(change, dict):
                raise ValueError(f"changes[{index}] 必须是包含 path、base_hash 及 content 或 edits 的 JSON 对象。")
            if not isinstance(change.get("path"), str) or not change["path"].strip():
                raise ValueError(f"changes[{index}].path 缺失或无效：每个文件都必须显式填写工作区相对路径，不能省略或依赖上一轮。")
            if not isinstance(change.get("base_hash"), str) or not change["base_hash"]:
                raise ValueError(f"changes[{index}].base_hash 缺失或无效：请使用 read 返回的真实 hash，新文件用 missing。")
            if ("content" in change) == ("edits" in change):
                raise ValueError("补丁必须提供 content 或 edits，二选一；删除文件使用 content: null。")
            path = workspace.path(change["path"])
            relative = path.relative_to(workspace.root).as_posix()
            if relative.casefold() in seen:
                raise ValueError("补丁中包含重复文件。")
            seen.add(relative.casefold())
            before = workspace.read(relative)["content"] if path.exists() else None
            if change.get("base_hash") != digest(before):
                raise Conflict(f"{relative} 的基线已变化，请重新读取文件。")
            after = self.apply_edits(before, change["edits"]) if "edits" in change else change["content"]
            if after is not None and (not isinstance(after, str) or "\x00" in after):
                raise ValueError("补丁仅接受文本内容或 null（删除文件）。")
            if after == before:
                raise ValueError(f"{relative} 没有实际改动。")
            if task.get("skill") == ANNOTATION_SKILL:
                validate_annotation_change(relative, before, after)
            if len(before or "") > 24_000 or len(after or "") > 24_000:
                raise ValueError("当前模型编辑工具限制单文件 24000 字符，请拆分修改。")
            total += len((after or "").encode("utf-8")) + len((before or "").encode("utf-8"))
            if total > MAX_FILE * 2:
                raise ValueError("补丁过大，请拆分为较小的修改。")
            prepared.append({"path": relative, "before": before, "after": after,
                             "before_hash": digest(before), "after_hash": digest(after),
                             "mode": stat.S_IMODE(path.stat().st_mode) if path.exists() else None})
        patch_id = identifier()
        self.store.execute("INSERT INTO patches VALUES(?,?,?,?,?,?)", (
            patch_id, task["id"], task["workspace_id"], "proposed", json.dumps(prepared, ensure_ascii=False), now()))
        return self.get(patch_id)

    @staticmethod
    def apply_edits(before: str | None, edits: list[dict]) -> str:
        """Build a full candidate in memory; exact matches refer to one baseline."""
        if before is None or not isinstance(edits, list) or not 1 <= len(edits) <= 100:
            raise ValueError("edits 仅适用于已有文件，每次需要 1–100 处替换。")
        spans = []
        for edit in edits:
            if not isinstance(edit, dict):
                raise ValueError("每项 edits 需要 old/new 字符串。")
            old, new = edit.get("old"), edit.get("new")
            if not isinstance(old, str) or not old or not isinstance(new, str):
                raise ValueError("edits.old 必须为非空原文，new 必须为替换后的文本。")
            start = before.find(old)
            if start < 0 or before.find(old, start + 1) >= 0:
                raise ValueError("edits.old 必须在原文件中精确且唯一匹配，请保留实际换行并增加上下文。")
            spans.append((start, start + len(old), new))
        spans.sort(key=lambda span: span[0])
        if any(left[1] > right[0] for left, right in zip(spans, spans[1:])):
            raise ValueError("edits 替换范围不能重叠。")
        after = before
        for start, end, new in reversed(spans):
            after = after[:start] + new + after[end:]
        return after

    def get(self, patch_id: str) -> dict:
        patch = self.store.one("patches", patch_id)
        patch["changes"] = json.loads(patch["changes"])
        for change in patch["changes"]:
            change["diff"] = "".join(difflib.unified_diff(
                (change["before"] or "").splitlines(keepends=True),
                (change["after"] or "").splitlines(keepends=True),
                fromfile="a/" + change["path"], tofile="b/" + change["path"]))
        return patch

    @staticmethod
    def write(path: Path, content: str | None, mode: int | None = None):
        if content is None:
            if path.exists():
                path.unlink()
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        if mode is None and path.exists():
            mode = stat.S_IMODE(path.stat().st_mode)
        fd, temporary = tempfile.mkstemp(prefix=".code-assistant-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content.encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            if mode is not None:
                os.chmod(temporary, mode)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def apply(self, patch_id: str, undo: bool = False) -> dict:
        patch = self.get(patch_id)
        allowed = {"applied", "recovery_required"} if undo else {"proposed"}
        if patch["status"] not in allowed:
            raise Conflict("补丁状态不允许此操作。")
        task = self.store.one("tasks", patch["task_id"])
        workspace = Workspace(self.store.one("workspaces", patch["workspace_id"])["root"],
                              include_build_sources=task.get("skill") == ANNOTATION_SKILL)
        expected, target = ("after", "before") if undo else ("before", "after")
        files = []
        for change in patch["changes"]:
            path = workspace.path(change["path"])
            current = workspace.read(change["path"])["content"] if path.exists() else None
            if patch["status"] == "recovery_required" and digest(current) == change["before_hash"]:
                continue
            if digest(current) != change[expected + "_hash"]:
                raise Conflict(f"{change['path']} 已被其他操作修改，未覆盖当前文件。")
            if not undo and task.get("skill") == ANNOTATION_SKILL:
                # Recheck legacy pending patches as well as newly generated ones.
                validate_annotation_change(change["path"], current, change["after"])
            files.append((path, current, change))
        self.store.execute("UPDATE patches SET status=? WHERE id=?", ("undoing" if undo else "applying", patch_id))
        written = []
        try:
            for path, current, change in files:
                self.write(path, change[target], change.get("mode"))
                written.append((path, current, change))
        except BaseException:
            for path, previous, change in reversed(written):
                self.write(path, previous, change.get("mode"))
            self.store.execute("UPDATE patches SET status=? WHERE id=?", (patch["status"], patch_id))
            raise
        self.store.execute("UPDATE patches SET status=? WHERE id=?", ("reverted" if undo else "applied", patch_id))
        return self.get(patch_id)
