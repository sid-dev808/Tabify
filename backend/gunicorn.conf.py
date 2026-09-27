"""Gunicorn settings.

Read automatically from the working directory, so these apply even when the
service's start command is just `gunicorn app:app` — which is what happens when
the Render service was created by hand rather than from render.yaml.
"""

# Transcription jobs live in this process's memory; a second worker would not
# see jobs created by the first.
workers = 1
threads = 4

# The default is 30 seconds, which silently kills a cold transcription mid-flight
# and returns a 500 with no CORS headers — indistinguishable, from the browser,
# from the API being down.
timeout = 300
graceful_timeout = 30

# Long enough that a slow client uploading audio is not dropped.
keepalive = 15

accesslog = "-"
errorlog = "-"
