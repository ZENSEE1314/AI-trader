FROM ollama/ollama:latest

# Expose the Ollama API port
EXPOSE 11434

# Create startup script that injects SSH key from env var then serves
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
