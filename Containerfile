FROM golang:1.26.2-bookworm

RUN apt-get update && apt-get install -y \
    python3 python3-venv python3-pip \
    unzip curl ca-certificates bash procps \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN python3 -m pip install --break-system-packages \
    fastapi uvicorn[standard] httpx pywidevine pydantic uvloop httptools

WORKDIR /lafdb

CMD ["/lafdb/entrypoint.sh"]
