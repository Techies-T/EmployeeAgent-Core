FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY pyproject.toml requirements.txt ./

# Install python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source & pre-built datasets
COPY src/ ./src/
COPY datasets/ ./datasets/
COPY mcp_http_server.py ./

# Install self as package
RUN pip install --no-cache-dir -e .

# Security: run as non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 33070

ENV ADMIN_PROCEDURES_HOST="0.0.0.0"
ENV ADMIN_PROCEDURES_PORT="33070"

CMD ["python", "mcp_http_server.py"]
