FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir psycopg2-binary redis numpy structlog

COPY . .

CMD ["python", "main.py"]
