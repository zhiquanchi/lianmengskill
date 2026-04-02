# Installation and Setup Guide

## Prerequisites

1. **Python 3.12 or higher**
   - Download from [python.org](https://www.python.org/downloads/)
   - Verify installation: `python --version`

2. **Node.js (optional, for icon generation)**
   - Only needed if you want to generate PNG icons from SVG

3. **Chrome or Edge browser**
   - Chrome 88+ or Edge 88+ with Manifest V3 support

## Backend Setup

### 1. Create Virtual Environment (Recommended)

```bash
# Create virtual environment
python -m venv .venv

# Activate on Windows
.venv\Scripts\activate

# Activate on macOS/Linux
source .venv/bin/activate
```

### 2. Install Dependencies

```bash
# Install package in development mode
pip install -e .

# Or install from requirements.txt
pip install -r requirements.txt
```

### 3. Configure Environment (Optional)

```bash
# Copy example environment file
cp .env.example .env

# Edit .env file with your preferences
# Most defaults should work for local development
```

### 4. Run the Backend Service

```bash
# Method 1: Using the installed script
grok-service

# Method 2: Direct Python execution
python -m grok_service.main

# Method 3: With uvicorn directly
uvicorn grok_service.main:app --host 127.0.0.1 --port 8765 --reload
```

The service will start on `http://127.0.0.1:8765` with WebSocket endpoint `ws://127.0.0.1:8765/ws`.

## Browser Extension Setup

### 1. Generate Icons (Optional)

If you have ImageMagick installed:

```bash
cd browser_extension/icons
convert icon.svg -resize 16x16 icon16.png
convert icon.svg -resize 32x32 icon32.png
convert icon.svg -resize 48x48 icon48.png
convert icon.svg -resize 128x128 icon128.png
```

Or create simple colored icons using any image editor.

### 2. Load Extension in Browser

#### Chrome:
1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `browser_extension/` directory

#### Edge:
1. Open Edge and go to `edge://extensions/`
2. Enable "Developer mode" (toggle in bottom left)
3. Click "Load unpacked"
4. Select the `browser_extension/` directory

### 3. Configure Extension

1. Click the Grok AI Assistant extension icon in your browser toolbar
2. Ensure WebSocket URL is set to `ws://localhost:8765/ws`
3. Click "Connect"
4. The status should change to "Connected"

## Testing the Setup

### 1. Verify Backend is Running

Open in browser or use curl:

```bash
curl http://localhost:8765/
# Should return: {"service":"Grok AI Browser Extension Backend","status":"running",...}
```

### 2. Verify Extension Connection

1. Open extension popup
2. Status should show "Connected"
3. "WebSocket" status should show a client ID

### 3. Test Question Submission

Using curl or any HTTP client:

```bash
curl -X POST http://localhost:8765/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the capital of France?"}'

# Response should contain answer and conversation_id
```

The extension will:
1. Open chat.x.ai in a new tab (if not already open)
2. Automatically enter the question and submit
3. Capture Grok's response
4. Save to local database
5. Return the answer via API

## Troubleshooting

### Extension won't connect
- Verify backend is running: `curl http://localhost:8765/health`
- Check WebSocket URL in extension popup
- Ensure no firewall blocking port 8765

### Grok tab not opening
- Check browser permissions allow opening tabs
- Verify `https://chat.x.ai/*` is in host_permissions in manifest.json
- Manually open chat.x.ai and log in first

### Questions not being answered
- Ensure you're logged into Grok in the browser
- Check browser console for errors (F12 → Console)
- Verify content script is injected (look for "Grok AI Content Script loaded" in console)

### Database issues
- Check file permissions for `grok_conversations.db`
- Ensure SQLite driver is installed (included with aiosqlite)

## Development

### Running Tests

```bash
# Install test dependencies
pip install pytest pytest-asyncio

# Run tests
pytest

# Run with coverage
pytest --cov=grok_service --cov-report=html
```

### Code Formatting

```bash
# Format code with black
black .

# Sort imports with isort
isort .

# Check code style
flake8 grok_service
```

### Project Structure

- `grok_service/` - Python backend (FastAPI + SQLAlchemy)
- `browser_extension/` - Chrome/Edge extension (Manifest V3)
- `tests/` - Test suite
- `pyproject.toml` - Project dependencies and configuration

## Security Notes

1. **Local only**: Service runs on localhost only by default
2. **No authentication**: Designed for single-user local use
3. **Browser permissions**: Extension only accesses chat.x.ai and local WebSocket
4. **Data storage**: Conversations stored locally in SQLite database

For production use, consider adding:
- Authentication
- HTTPS for WebSocket
- Database encryption
- Request rate limiting