FROM ollama/ollama:latest

# Expose the Ollama API port
EXPOSE 11434

# Override entrypoint to inject SSH key before Ollama starts
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/bin/bash"]
CMD ["/start.sh"]
