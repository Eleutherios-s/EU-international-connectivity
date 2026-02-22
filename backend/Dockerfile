FROM python:3.12-slim

WORKDIR /app

# Copy the list of necessary dependencies
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application files
COPY . .

# Expose the application port
EXPOSE 8000

# Start the application, allow for connections from any host on port 8000, and enable hot reloading
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
