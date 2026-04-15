FROM ollama/ollama:latest

# Expose the Ollama API port
EXPOSE 11434

# Create startup script that pulls model then serves
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Ollama stores models in /root/.ollama
VOLUME /root/.ollama

CMD ["/start.sh"]
