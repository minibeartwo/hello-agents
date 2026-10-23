"""HelloAgents streaming adapter; the application owns task lifecycle and tool policy."""
from __future__ import annotations

import asyncio
import json
import re
import threading
from urllib.parse import urlparse


def tool_messages(messages: list[dict]) -> list[dict]:
    """Use actual persisted call IDs only when paired with a real observation."""
    result, index = [], 0
    while index < len(messages):
        item = messages[index]
        following = messages[index + 1] if index + 1 < len(messages) else None
        calls = item.get("tool_calls")
        if item["role"] == "assistant" and calls and following and following["role"] == "user" and following["content"].startswith("工具观察："):
            result.append({"role": "assistant", "content": None, "tool_calls": calls})
            result.append({"role": "tool", "tool_call_id": calls[0]["id"], "content": following["content"][len("工具观察："):]})
            index += 2
        else:
            result.append({"role": item["role"], "content": item["content"]})
            index += 1
    return result


def action_tool() -> dict:
    # Describe nested patch fields too; an unconstrained args object encouraged
    # missing paths even though the outer function call was valid JSON.
    text = {"type": "string"}
    edit = {"type": "object", "properties": {"old": text, "new": text},
            "required": ["old", "new"], "additionalProperties": False}
    change = {"type": "object", "properties": {
        "path": {"type": "string", "description": "必填，工作区相对文件路径，每一项都不能省略。"},
        "base_hash": {"type": "string", "description": "必填，真实 read 返回的 hash，新文件为 missing。"},
        "content": {"type": ["string", "null"], "description": "完整候选文本，删除为 null；与 edits 二选一。"},
        "edits": {"type": "array", "items": edit, "minItems": 1,
                  "description": "局部替换列表，与 content 二选一；old 必须与原文唯一精确匹配。"}},
        "required": ["path", "base_hash"], "additionalProperties": False}
    args = {"type": "object", "properties": {
        "path": {"type": "string", "description": "list/read 使用的工作区相对路径。"},
        "query": {"type": "string", "description": "search 的字面搜索内容。"},
        "offset": {"type": "integer", "minimum": 0, "description": "inventory 的分页偏移。"},
        "changes": {"type": "array", "items": change, "minItems": 1, "maxItems": 5,
                    "description": "propose_patch 必填，每个文件都需要 path/base_hash，以及 content 或 edits。"},
        "message": {"type": "string", "description": "final 必填，面向用户的最终说明。"}},
        "additionalProperties": False,
        "description": "使用动作对应字段；read 必填 path，search 必填 query，propose_patch 必填 changes，final 必填 message。"}
    return {"type": "function", "function": {
        "name": "submit_action", "description": "提交一个客户端动作，然后等待真实工具结果；不得模拟执行。",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": sorted(ACTIONS)},
            "args": args,
            "summary": {"type": "string", "description": "简短中文进度说明。"}},
            "required": ["action", "args", "summary"], "additionalProperties": False}}}


class HelloModel:
    def __init__(self, settings, key: str):
        if not settings["model"] or not settings["base_url"]:
            raise ValueError("请先在模型设置中填写模型名称和 API 地址。")
        if not key and urlparse(settings["base_url"]).hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("请先设置模型 API Key。")
        from hello_agents import HelloAgentsLLM
        from openai import OpenAI
        import httpx
        local = urlparse(settings["base_url"]).hostname in {"localhost", "127.0.0.1", "::1"}

        class TransportLLM(HelloAgentsLLM):
            def _create_client(self):
                # Loopback services must bypass Windows system proxies as well.
                return OpenAI(api_key=self.api_key, base_url=self.base_url, timeout=self.timeout,
                              max_retries=0, http_client=httpx.Client(trust_env=not local, timeout=self.timeout))

            def think(self, messages, temperature=None):
                self.last_tool_call = None
                from openai import BadRequestError
                options = {}
                if urlparse(self.base_url).hostname == "api.deepseek.com":
                    options["extra_body"] = {"thinking": {"type": "disabled"}}
                try:
                    stream = self._client.chat.completions.create(
                        model=self.model, messages=tool_messages(messages),
                        temperature=self.temperature if temperature is None else temperature,
                        max_tokens=self.max_tokens, stream=True,
                        tools=[action_tool()],
                        tool_choice={"type": "function", "function": {"name": "submit_action"}},
                        **options)
                except BadRequestError as exc:
                    if any(name in str(exc) for name in ("tools", "tool_choice", "function")):
                        raise ValueError("模型服务拒绝原生工具调用，请检查服务是否支持 tools/tool_choice。") from exc
                    raise
                calls, text, size = {}, [], 0
                with stream:
                    for chunk in stream:
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        if choice.delta.content:
                            text.append(choice.delta.content)
                            size += len(choice.delta.content)
                        for part in choice.delta.tool_calls or []:
                            call = calls.setdefault(part.index, {"id": "", "name": "", "arguments": ""})
                            call["id"] += part.id or ""
                            if part.function:
                                call["name"] += part.function.name or ""
                                value = part.function.arguments or ""
                                call["arguments"] += value
                                size += len(value)
                                if value:
                                    yield value
                        if size > 60_000:
                            raise ActionFormatError("模型单轮响应超过大小限制，请减小补丁。")
                        if choice.finish_reason == "length":
                            raise ModelOutputTruncated("模型输出达到 token 或上下文长度上限，被截断；本轮补丁未执行。")
                        if choice.finish_reason not in {None, "stop", "tool_calls"}:
                            raise ActionFormatError(f"模型生成未正常结束（{choice.finish_reason}），本轮动作未执行。")
                if calls:
                    if len(calls) != 1:
                        raise ActionFormatError("每轮仅允许一个原生工具调用，本轮所有动作均未执行。")
                    call = next(iter(calls.values()))
                    if call["name"] != "submit_action" or not call["id"]:
                        raise ActionFormatError("模型返回未知或不完整的工具调用。")
                    self.last_tool_call = {"id": call["id"], "type": "function", "function": {
                        "name": call["name"], "arguments": call["arguments"]}}
                else:
                    # Compatibility for gateways that still return action text.
                    yield "".join(text)

        self.llm = TransportLLM(model=settings["model"], api_key=key or "local", base_url=settings["base_url"], provider="custom", temperature=0.2, max_tokens=8192, timeout=60)

    async def generate(self, messages: list[dict], emit) -> str:
        loop, queue, stopped = asyncio.get_running_loop(), asyncio.Queue(), threading.Event()

        def publish(kind, value):
            if stopped.is_set():
                return
            try:
                loop.call_soon_threadsafe(queue.put_nowait, (kind, value))
            except RuntimeError:
                pass  # The service may have shut down after cancellation.

        def worker():
            stream = None
            try:
                stream = self.llm.think(messages)
                parts, pending, total = [], "", 0
                for chunk in stream:
                    if stopped.is_set():
                        break
                    total += len(chunk)
                    if total > 60_000:
                        raise ValueError("模型单步输出超过限制，请拆分任务。")
                    parts.append(chunk)
                    pending += chunk
                    if len(pending) >= 180:
                        publish("delta", pending)
                        pending = ""
                if pending:
                    publish("delta", pending)
                publish("done", "".join(parts))
            except Exception as exc:
                publish("error", exc)
            finally:
                if stream:
                    stream.close()

        thread = threading.Thread(target=worker, daemon=True, name="code-assistant-model")
        thread.start()
        try:
            while True:
                kind, value = await queue.get()
                if kind == "done":
                    self.last_tool_call = getattr(self.llm, "last_tool_call", None)
                    return value
                if kind == "error":
                    from openai import APITimeoutError
                    import httpx
                    if isinstance(value, (APITimeoutError, httpx.TimeoutException, TimeoutError)):
                        raise ModelRequestTimeout("模型请求超时，未收到完整响应，本轮未执行工具。") from value
                    if isinstance(value, ValueError):
                        raise value
                    raise ValueError(str(value))
                await emit("model.delta", {"text": value})
        finally:
            stopped.set()

    def close(self):
        # The 0.2.9 learning release exposes no close() API; isolate that detail here.
        self.llm._client.close()


class ActionFormatError(ValueError):
    """A response cannot be used as one unambiguous local tool action."""


class ModelRequestTimeout(ValueError):
    """A transport timeout is separate from invalid model output or task limits."""


class ModelOutputTruncated(ActionFormatError):
    """An incomplete output must never become a proposed file modification."""


# Some providers append simulated observations. These are discarded, never executed
# or passed back to the model as evidence. Other trailing content remains an error.
SIMULATED_OBSERVATIONS = re.compile(r"(?:\s*<system>\s*工具观察：(?:(?!</system>).)*</system>)*\s*", re.DOTALL)
ACTIONS = {"list", "read", "search", "git_diff", "inventory", "propose_patch", "test", "final"}
READ_ONLY_ACTIONS = {"list", "read", "search", "git_diff", "inventory"}


def _complete_outer_object(text: str) -> str | None:
    """Close only one missing root brace after otherwise complete JSON values.

    Never repair open strings, nested containers, mismatched delimiters, commas
    or escapes: those could change the actual tool parameters or file content.
    """
    stack, quoted, escaped = [], False, False
    for character in text:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "{[":
            stack.append(character)
        elif character in "}]":
            if not stack or stack.pop() != {"}": "{", "]": "["}[character]:
                return None
    if not quoted and not escaped and stack == ["{"]:
        candidate = text + "}"
        try:
            json.loads(candidate)
        except (json.JSONDecodeError, RecursionError):
            return None
        return candidate
    return None


def parse_action(text: str, *, diagnostics: list[str] | None = None) -> dict:
    repairs = []
    stripped = text.lstrip("\ufeff").strip()
    if not stripped:
        raise ActionFormatError("模型返回了空内容，没有可执行的动作 JSON。")
    if stripped.startswith("<｜｜DSML｜｜"):
        raise ActionFormatError("模型返回了 DSML 工具标记；当前客户端要求单个动作 JSON。")
    fenced = stripped.startswith("```")
    if fenced:
        header, separator, stripped = stripped.partition("\n")
        if not separator or header.strip().lower() not in {"```", "```json"}:
            raise ActionFormatError("模型没有返回有效的 JSON 代码块。")
        stripped = stripped.lstrip()
    try:
        data, end = json.JSONDecoder().raw_decode(stripped)
    except (json.JSONDecodeError, RecursionError) as exc:
        candidate = _complete_outer_object(stripped) if isinstance(exc, json.JSONDecodeError) and exc.pos == len(stripped) else None
        if candidate is None:
            location = f"（第 {exc.lineno} 行，第 {exc.colno} 列）" if isinstance(exc, json.JSONDecodeError) else ""
            raise ActionFormatError(f"模型动作 JSON 不完整或转义不合法{location}，本轮未执行；请缩小补丁并返回完整参数。") from exc
        stripped = candidate
        data, end = json.JSONDecoder().raw_decode(stripped)
        repairs.append("已补齐工具参数末尾缺失的单个外层大括号；未修改补丁文本。")
    trailing = stripped[end:]
    # The first object is already complete. A lone duplicated root delimiter
    # contains no arguments or instructions; never discard other write tails.
    if trailing.strip() == "}":
        trailing = ""
        repairs.append("已忽略完整动作末尾多余的单个大括号；未修改补丁文本。")
    if fenced:
        trailing = trailing.lstrip()
        if not trailing.startswith("```"):
            raise ActionFormatError("模型的 JSON 代码块没有正确结束。")
        trailing = trailing[3:]
    if not isinstance(data, dict) or not isinstance(data.get("action"), str) or data["action"] not in ACTIONS:
        raise ActionFormatError("模型返回了不支持的动作。")
    if not isinstance(data.get("args", {}), dict):
        raise ActionFormatError("动作参数需要是 JSON 对象。")
    if "summary" not in data and isinstance(data.get("args", {}).get("summary"), str):
        data["args"] = dict(data["args"])
        data["summary"] = data["args"].pop("summary")
        repairs.append("已将误放在 args 中的进度说明归位。")
    if "summary" in data and not isinstance(data["summary"], str):
        raise ActionFormatError("动作 summary 需要是简短字符串。")
    if data["action"] not in READ_ONLY_ACTIONS and not SIMULATED_OBSERVATIONS.fullmatch(trailing):
        raise ActionFormatError("修改或结束动作附带了额外内容，本轮未执行。")
    if diagnostics is not None:
        diagnostics.extend(repairs)
    return {key: data[key] for key in ("action", "args", "summary") if key in data}
