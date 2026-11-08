import os
import sys
import json
import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.requests import Request
from admin_procedures.server import mcp

async def handle_mcp(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None}, status_code=400)

    method = body.get("method")
    req_id = body.get("id")
    params = body.get("params", {})

    if method == "tools/list":
        try:
            tools = await mcp.list_tools()
            tools_json = []
            for t in tools:
                schema = getattr(t, "parameters", None) or getattr(t, "inputSchema", None) or {}
                if hasattr(schema, "model_dump"):
                    schema = schema.model_dump()
                elif hasattr(schema, "dict"):
                    schema = schema.dict()
                tools_json.append({
                    "name": t.name,
                    "description": t.description or "",
                    "inputSchema": schema
                })
            return JSONResponse({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": tools_json}
            })
        except Exception as e:
            return JSONResponse({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": str(e)}
            }, status_code=500)

    elif method == "tools/call":
        tool_name = params.get("name")
        tool_args = params.get("arguments", {})
        try:
            result = await mcp.call_tool(tool_name, tool_args)
            content_list = []
            if hasattr(result, "content"):
                for c in result.content:
                    if hasattr(c, "text"):
                        content_list.append({"type": "text", "text": c.text})
                    else:
                        content_list.append({"type": "text", "text": str(c)})
            elif isinstance(result, list):
                for item in result:
                    if hasattr(item, "text"):
                        content_list.append({"type": "text", "text": item.text})
                    else:
                        content_list.append({"type": "text", "text": str(item)})
            else:
                content_list.append({"type": "text", "text": str(result)})

            return JSONResponse({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": content_list
                }
            })
        except Exception as e:
            return JSONResponse({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": f"Error calling {tool_name}: {str(e)}"}
            }, status_code=500)

    elif method == "ping":
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": {}})

    else:
        return JSONResponse({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"}
        }, status_code=404)

routes = [
    Route("/mcp", handle_mcp, methods=["POST"])
]

app = Starlette(routes=routes)

if __name__ == "__main__":
    port = int(os.environ.get("ADMIN_PROCEDURES_PORT", 33070))
    host = os.environ.get("ADMIN_PROCEDURES_HOST", "0.0.0.0")
    print(f"Starting Digital Agency Procedures MCP JSON-RPC Server on {host}:{port}/mcp")
    uvicorn.run(app, host=host, port=port, log_level="info")
