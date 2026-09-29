# Postgres 16 + pgvector + PostGIS.
#
# There is no single upstream image carrying all three, and the two obvious
# bases are each missing something we depend on:
#
#   postgis/postgis:16-3.4  -> has PostGIS (issues.location is GEOGRAPHY and
#                              every findNearbyActiveIssue query is an
#                              indexed ST_DWithin), but no pgvector.
#   pgvector/pgvector:pg16  -> has pgvector, but no PostGIS, so migration
#                              0001's `CREATE EXTENSION postgis` fails and
#                              the whole store fails to boot.
#
# So PostGIS is installed as a package from the PostgreSQL apt repository onto
# the pgvector image, rather than choosing one base over the other. Both bases
# derive from the official postgres:16 image, so the layout, the postgres user
# and the data directory are identical either way.
#
# The base was NOT switched the other way round — building pgvector on top of
# postgis/postgis:16-3.4 is not an option, because that tag is built on Debian
# bullseye, which has since been retired. Its apt repositories no longer
# resolve, so no package can be installed on top of it and even a from-source
# pgvector build is impossible. pgvector/pgvector:pg16 is bookworm-based, so
# its repositories are live.
#
# Set PG_MAJOR below only if the base tag is ever bumped; it selects the
# PostGIS package matching the server version.
FROM pgvector/pgvector:pg16

ARG PG_MAJOR=16

# Installed from apt.postgresql.org, which the pgvector image already trusts
# for its own packages. --no-install-recommends keeps the postgis-3-scripts
# dependency chain (GDAL, GEOS, PROJ, libprotobuf) out where it is not needed.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}-postgis-3" \
        "postgresql-${PG_MAJOR}-postgis-3-scripts"; \
    rm -rf /var/lib/apt/lists/*
