FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Copy quant engine
COPY --from=quant /app/quant /app/quant

CMD ["python", "main.py"]
