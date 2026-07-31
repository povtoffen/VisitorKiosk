services:
  besucher-schluessel:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
      KIOSK_API_KEY: ${KIOSK_API_KEY}
      SESSION_SECRET: ${SESSION_SECRET}
      STANDORTE: ${STANDORTE:-}
      STANDORT_DOMAINS: ${STANDORT_DOMAINS:-}
      ADMIN_USERS: ${ADMIN_USERS:-}
      CORS_ORIGIN: ${CORS_ORIGIN:-*}
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_SECURE: ${SMTP_SECURE:-false}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASS: ${SMTP_PASS:-}
      SMTP_FROM: ${SMTP_FROM:-}
      DB_PATH: /app/data/data.db
    volumes:
      - besucher-data:/app/data

volumes:
  besucher-data:
