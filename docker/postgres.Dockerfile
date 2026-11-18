FROM postgres:16-alpine

# Copy database initialization schema
COPY ./docker/init.sql /docker-entrypoint-initdb.d/01-init.sql

# Expose standard PostgreSQL port
EXPOSE 5432
