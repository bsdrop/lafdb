import base64
import uvloop
uvloop.install()

import json as json_mod
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

# Apple's Widevine service certificate — fetched from widevineCert endpoint.
# The challenge must be encrypted with this cert or Apple returns 500.
APPLE_WIDEVINE_CERT_B64 = (
    "CrsCCAMSEH5Yv8Sjn3SNZfleUtLKvUQYj4K6mwYijgIwggEKAoIBAQCqK2dyEEMkaIO/71c9SNcd"
    "zjMJfRI0qPepX7zHUdcxcg1iLuwE/UpmcaKWFPOdhaB4R6cO9J5ikTVktQP4sgT2x/wzE9YcJzBX"
    "sAoMXnNEQHXB8d7wtI85ajdZFSb8vekncLZEKPVMAPP5i9wgA9W8AvgZLRrDRUsI4sSDMabrZz/F"
    "szSVWovzeL+Jx/Cp1i3NjrVihn2eRDsN+wkDq5TRCVGZYxo0pgpYy9k5vwmvChxjdbE9X9Mnolca"
    "2X6GUwXRTCOZsntLzEjXcRQkl0j7ULdc2MWXVByCil9Cduz+P4f+7cXmhATpWpuyJhm0nz5dldTI"
    "lL+PHDiccjTRkL0RAgMBAAE6CmlyZGV0by5jb21AAUgBEoADJPm6nR946mv03m1LsxVuMSiEAtdR"
    "/cSoezPHM6htgE2cqcg98JD9q/y1MfWcUYSRQxM0zdQNCX6WpvAVmKlDo7Ar3IY5j7bNfpDLzqow"
    "cNzne4q0sVruK4DlJI0ZA8upJekEJuQSfgWEjS3GZioGpV6bM39cM754+BOTs9Vnl1AahEhjJKW2"
    "zsvlJf5TlwcXnEKNyUW8PHLMJrDig0vB61MpO2/tfJNO6hcMraFVQpBOAiSToY2AxoBRHAzsIlMT"
    "2qSdXOFwnnOkVtAoEMd1KM3Kiw/DExfQmAsXzrA3Nr6GTC+J6W8BScWURTqr8J1bVv0mj2yMaEe"
    "diq5oHxOwXq1eZOGm1dl5qfwH/EFOkResIUTEnpZN1ILOJL7IZ7kq1hC8G5aDta+zjBVENjeube4"
    "8wvXXEIrGfozoEpK1bYAV+kZT+qmezrXQdG1Z8+/No4VAEax8u9Re2KHLq/FvCC2I/4ivc6Ronvv"
    "098TwMnoZarF6EMqKhz8BBd8RsRKn"
)
APPLE_WIDEVINE_CERT = base64.b64decode(APPLE_WIDEVINE_CERT_B64)


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

        # Apple Music uses a JSON envelope: {"challenge": "<b64>"} → {"license": "<b64>"}
        apple_json_mode = "acquireWebPlaybackLicense" in lic_url

        if apple_json_mode:
            # Apple requires the challenge to be encrypted with their service cert.
            cdm.set_service_certificate(session_id, APPLE_WIDEVINE_CERT)

        challenge = cdm.get_license_challenge(session_id, pssh)

        client_kwargs = {"timeout": 10.0}
        if req.proxy:
            client_kwargs["proxies"] = req.proxy

        async with httpx.AsyncClient(**client_kwargs) as client:
            if apple_json_mode:
                json_headers = dict(req.headers or {})
                json_headers.setdefault("Content-Type", "application/json")
                resp = await client.post(
                    lic_url,
                    json={"challenge": base64.b64encode(challenge).decode()},
                    headers=json_headers,
                    cookies=req.cookies,
                )
            else:
                resp = await client.post(
                    lic_url, content=challenge, headers=req.headers, cookies=req.cookies
                )

        if resp.status_code != 200:
            sent_headers = json_headers if apple_json_mode else dict(req.headers or {})
            return {
                "status": "fail",
                "message": (
                    f"License server returned {resp.status_code}. "
                    f"resp_body={resp.text[:300]!r} "
                    f"sent_headers={list(sent_headers.keys())} "
                    f"challenge_len={len(challenge)}"
                ),
            }

        if apple_json_mode:
            license_b64 = resp.json().get("license", "")
            license_bytes = base64.b64decode(license_b64)
        else:
            license_bytes = resp.content

        cdm.parse_license(session_id, license_bytes)

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
