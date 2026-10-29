FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 1000 --create-home cow
COPY network_config.py settlement_state.py wrapper_prediction.py ./
COPY backend/ backend/
COPY solver/ solver/
COPY deployment/ deployment/
COPY config/ config/
COPY ui/ ui/
RUN mkdir -p runtime && chown cow:cow runtime
USER cow
EXPOSE 8787
CMD ["python", "backend/server.py"]
