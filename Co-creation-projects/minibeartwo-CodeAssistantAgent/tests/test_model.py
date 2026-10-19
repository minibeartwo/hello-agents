"""Exercise the installed HelloAgents adapter against a local streaming endpoint."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from backend.model import HelloModel, parse_action


async def test_helloagents_real_streaming_adapter():
    requests = []
    response = json.dumps({"action": "final", "args": {"message": "本地协议测试通过。"}})

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            for text in [response[:20], response[20:]]:
                chunk = {"id": "local-test", "object": "chat.completion.chunk", "created": 0, "model": "protocol-test", "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    model = HelloModel({"model": "protocol-test", "base_url": f"http://127.0.0.1:{server.server_port}/v1"}, "")
    emitted = []

    async def emit(kind, data):
        emitted.append((kind, data))

    try:
        result = await model.generate([{"role": "user", "content": "hello"}], emit)
        assert parse_action(result)["args"]["message"] == "本地协议测试通过。"
        assert requests[0]["stream"] is True and requests[0]["model"] == "protocol-test"
        assert emitted and emitted[0][0] == "model.delta"
    finally:
        model.close()
        server.shutdown()
        server.server_close()
