#!/usr/bin/env python3
"""Small JSON client; workflow/authorization rules live in SKILL.md."""

import argparse
import getpass
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


class ApiError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_api(path, method="GET", body=None, *, base_url=None, token=None):
    base = (base_url or os.environ.get("VIKUNJA_URL", "http://192.168.0.172:3456")).rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ApiError("VIKUNJA_URL must be an HTTP(S) base URL without credentials or query parameters")
    if parsed.path.endswith("/api/v1"):
        raise ApiError("VIKUNJA_URL must not include /api/v1")
    endpoint = urllib.parse.urlsplit(path)
    if not path.startswith("/") or path.startswith("//") or endpoint.fragment or any(part == ".." for part in urllib.parse.unquote(endpoint.path).split("/")):
        raise ApiError("Use an API-relative path such as /projects; external URLs and parent paths are not allowed")
    if method not in ("GET", "POST", "PUT", "DELETE"):
        raise ApiError("Unsupported HTTP method")
    if method == "GET" and body is not None:
        raise ApiError("GET requests do not accept a body")
    token = os.environ.get("VIKUNJA_API_TOKEN", "") if token is None else token
    public = method == "GET" and endpoint.path in ("/info", "/docs.json")
    if not public and not token:
        raise ApiError("Set VIKUNJA_API_TOKEN or use --prompt-token; a GitHub PAT is not a Vikunja token")
    headers = {"Accept": "application/json", "User-Agent": "fms-kanban-skill"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + "/api/v1" + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            text = response.read().decode("utf-8")
            pagination = {key: response.headers.get(header) for key, header in (
                ("total_pages", "X-Pagination-Total-Pages"), ("result_count", "X-Pagination-Result-Count"))}
            return {"status": response.status, "pagination": pagination, "data": json.loads(text) if text else None}
    except urllib.error.HTTPError as error:
        # Do not echo arbitrary server error bodies or retry a possibly applied mutation.
        hint = " Check VIKUNJA_URL (redirects are disabled)." if 300 <= error.code < 400 else ""
        raise ApiError(f"Vikunja HTTP {error.code}.{hint} No automatic retry was performed.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ApiError("Vikunja connection failed. Check URL/network; read server state before retrying a write.") from None
    except (ValueError, UnicodeError):
        raise ApiError("Vikunja returned a non-JSON response; confirm the URL and API version") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="API-relative path, e.g. /projects?page=1&per_page=50")
    parser.add_argument("--method", choices=("GET", "POST", "PUT", "DELETE"), default="GET")
    parser.add_argument("--body-file", type=Path, help="JSON body file (never a token file)")
    parser.add_argument("--prompt-token", action="store_true", help="Read token without echo in an interactive terminal")
    args = parser.parse_args()
    token = getpass.getpass("Vikunja API token: ") if args.prompt_token else os.environ.get("VIKUNJA_API_TOKEN", "")
    try:
        body = json.loads(args.body_file.read_text(encoding="utf-8")) if args.body_file else None
        result = request_api(args.path, args.method, body, token=token)
        output = json.dumps(result, ensure_ascii=False, indent=2)
        print(output.replace(token, "[REDACTED]") if token else output)
        return 0
    except (ApiError, OSError, ValueError) as error:
        message = str(error)
        print(message.replace(token, "[REDACTED]") if token else message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
