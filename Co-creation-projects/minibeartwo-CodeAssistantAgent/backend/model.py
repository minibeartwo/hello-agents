"""HelloAgents streaming adapter; the application owns task lifecycle and tool policy."""
from __future__ import annotations

import asyncio
import json
import threading
from urllib.parse import urlparse


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
                publish("error", str(exc))
            finally:
                if stream:
                    stream.close()

        thread = threading.Thread(target=worker, daemon=True, name="code-assistant-model")
        thread.start()
        try:
            while True:
                kind, value = await queue.get()
                if kind == "done":
                    return value
                if kind == "error":
                    raise ValueError(value)
                await emit("model.delta", {"text": value})
        finally:
            stopped.set()

    def close(self):
        # The 0.2.9 learning release exposes no close() API; isolate that detail here.
        self.llm._client.close()


def parse_action(text: str) -> dict:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ValueError("模型没有返回有效的动作 JSON。") from exc
    if not isinstance(data, dict) or data.get("action") not in {"list", "read", "search", "git_diff", "propose_patch", "test", "final"}:
        raise ValueError("模型返回了不支持的动作。")
    if not isinstance(data.get("args", {}), dict):
        raise ValueError("动作参数需要是 JSON 对象。")
    return data
