import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from vikunja_api import ApiError, request_api


class Handler(BaseHTTPRequestHandler):
    def handle_request(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append((self.command, self.path, self.headers.get("Authorization"), data))
        self.send_response(self.server.status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Pagination-Total-Pages", "3")
        if self.server.status_code == 302:
            self.send_header("Location", "/redirect-target")
        self.end_headers()
        self.wfile.write(json.dumps(self.server.response_data).encode())

    do_GET = do_POST = do_PUT = do_DELETE = handle_request

    def log_message(self, *args):
        pass


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def setUp(self):
        self.server.requests = []
        self.server.status_code = 200
        self.server.response_data = [{"id": 7, "title": "robot"}]

    def test_authenticated_query_and_pagination(self):
        result = request_api("/projects?page=2&per_page=50", base_url=self.base, token="test-token")
        self.assertEqual(result["pagination"]["total_pages"], "3")
        self.assertEqual(result["data"][0]["id"], 7)
        self.assertEqual(self.server.requests[0][:3], ("GET", "/api/v1/projects?page=2&per_page=50", "Bearer test-token"))

    def test_json_write_preserves_unicode_and_newlines(self):
        body = {"description": "합의 내용\n///////////////\n원문 보존", "done": False}
        for method in ("PUT", "POST"):
            request_api("/tasks/7", method, body, base_url=self.base, token="test-token")
            self.assertEqual(self.server.requests[-1][0], method)
            self.assertEqual(json.loads(self.server.requests[-1][3]), body)

    def test_forbidden_write_is_not_retried_and_error_body_is_not_exposed(self):
        self.server.status_code = 403
        self.server.response_data = {"message": "test-secret-server-body"}
        with self.assertRaises(ApiError) as caught:
            request_api("/tasks/7", "POST", {"title": "one write"}, base_url=self.base, token="test-token")
        self.assertIn("403", str(caught.exception))
        self.assertNotIn("test-secret", str(caught.exception))
        self.assertEqual(len(self.server.requests), 1)

    def test_redirect_does_not_forward_credentials(self):
        self.server.status_code = 302
        with self.assertRaisesRegex(ApiError, "redirects are disabled"):
            request_api("/projects", base_url=self.base, token="test-token")
        self.assertEqual(len(self.server.requests), 1)

    def test_missing_token_and_bad_paths_do_not_send_requests(self):
        with self.assertRaisesRegex(ApiError, "VIKUNJA_API_TOKEN"):
            request_api("/projects", base_url=self.base, token="")
        for path in ("https://example.invalid/", "//example.invalid/", "/../projects", "/%2e%2e/projects"):
            with self.assertRaises(ApiError):
                request_api(path, base_url=self.base, token="test-token")
        with self.assertRaises(ApiError):
            request_api("/projects", base_url="https://user:password@example.invalid", token="test-token")
        self.assertEqual(self.server.requests, [])

    def test_public_info_can_be_read_without_token(self):
        request_api("/info", base_url=self.base, token="")
        self.assertIsNone(self.server.requests[0][2])


if __name__ == "__main__":
    unittest.main()
