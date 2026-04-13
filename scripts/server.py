import uvloop
uvloop.install()

from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, Field
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

LAFTEL_DIR = Path(__file__).parent
print(LAFTEL_DIR)

app = FastAPI()

device = Device.load(str(LAFTEL_DIR / "provision.wvd"))
cdm = Cdm.from_device(device)


class DecryptRequest(BaseModel):
    pssh: Optional[str] = None
    license_url: Optional[str] = Field(
        None, alias="licurl"
    )  # licurl과 license_url 모두 대응
    headers: Optional[Dict[str, str]] = None
    cookies: Optional[Dict[str, Any]] = None
    proxy: Optional[str] = None
    data: Optional[Any] = None
    device: Optional[str] = "public"

    class Config:
        populate_by_name = True


@app.post("/api/decrypt")
async def decrypt_data(req: DecryptRequest):
    pssh_str = req.pssh
    lic_url = req.license_url

    if not pssh_str or not lic_url:
        return {"status": "fail", "message": "PSSH or License URL is missing"}, 400

    session_id = None
    try:
        pssh = PSSH(pssh_str)
        session_id = cdm.open()
        challenge = cdm.get_license_challenge(session_id, pssh)

        client_kwargs = {"timeout": 10.0}
        if req.proxy:
            client_kwargs["proxies"] = req.proxy

        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.post(
                lic_url, content=challenge, headers=req.headers, cookies=req.cookies
            )

        if resp.status_code != 200:
            return {
                "status": "fail",
                "message": f"License server returned {resp.status_code}",
            }

        cdm.parse_license(session_id, resp.content)

        returned_keys = []
        for key in cdm.get_keys(session_id):
            if key.type == "CONTENT":
                returned_keys.append(
                    {
                        "key_id": key.kid.hex,
                        "key": key.key.hex(),
                    }
                )
            else:
                print(key.type, key.kid.hex, key.key.hex(), "skipped")
        cdm.close(session_id)
        print(req.pssh, returned_keys)
        return {"status": "success", "message": returned_keys}

    except Exception as e:
        if session_id:
            cdm.close_session(session_id)
        return {"status": "fail", "message": str(e)}
