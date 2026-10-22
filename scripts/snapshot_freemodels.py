#!/usr/bin/env python3
"""生成 Cline 免费模型名单初始快照 (.freemodels-snapshot.json)"""
import json, urllib.request, datetime

req = urllib.request.Request(
    "https://api.cline.bot/api/v1/ai/cline/recommended-models",
    headers={"User-Agent": "Mozilla/5.0"},
)
with urllib.request.urlopen(req, timeout=25) as resp:
    d = json.load(resp)

snap = {
    "free": [m["id"] for m in d.get("free", [])],
    "clinePass_count": len(d.get("clinePass", [])),
    "clineCloud_count": len(d.get("clineCloud", [])),
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
path = "/root/cline2api-workers/.freemodels-snapshot.json"
with open(path, "w") as f:
    json.dump(snap, f, indent=1)
print(json.dumps(snap, indent=1))
