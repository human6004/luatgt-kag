# Build from pinned upstream and project source; no author cache is required.
ARG KAG_RUNTIME_IMAGE=spg-registry.us-west-1.cr.aliyuncs.com/spg/openspg-server@sha256:fe6708deef9ebb8da8da7b1cb643e83b827769a5be8811961311639aa1f2cb88
FROM ${KAG_RUNTIME_IMAGE}
USER 0
WORKDIR /workspace
COPY requirements.txt requirements-http-api.txt .python-version ./
RUN python -m venv /opt/kag-venv \
    && /opt/kag-venv/bin/python -m pip install --timeout 120 --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && /opt/kag-venv/bin/python -m pip install --timeout 120 --no-cache-dir --no-deps --require-hashes -r requirements-http-api.txt
ENV PATH="/opt/kag-venv/bin:${PATH}"
RUN python -m pip check \
    && python -c "import platform,sys; assert sys.version_info[:3]==(3,10,16) and platform.system()=='Linux' and platform.machine()=='x86_64'" \
    && python -c "from importlib.metadata import version; from pathlib import Path; rows=[s.split('==') for s in Path('requirements.txt').read_text().splitlines() if s and not s.startswith('#')]; assert all(version(n)==v for n,v in rows)"
COPY --chown=10001:10001 docker/openspg-server.sh ./docker/openspg-server.sh
COPY --chown=10001:10001 kag/ ./kag/
COPY --chown=10001:10001 data/processed/ ./data/processed/
COPY --chown=10001:10001 vendor/KAG/ ./vendor/KAG/
# Verify the copied SDK against its upstream commit without host Git metadata.
USER 10001:10001
RUN git init -q vendor/KAG \
    && git -C vendor/KAG fetch --depth=1 https://github.com/OpenSPG/KAG.git fdab15b3929d2ee40dfcdd388f90233096a6afc9 \
    && git -C vendor/KAG update-ref HEAD fdab15b3929d2ee40dfcdd388f90233096a6afc9 \
    && git -C vendor/KAG config core.autocrlf true \
    && git -C vendor/KAG config core.filemode false \
    && git -C vendor/KAG read-tree HEAD \
    && test -z "$(git -C vendor/KAG status --porcelain --untracked-files=all)"
# Operators may use a different UID; this immutable path still gets full source validation.
USER 0
RUN git config --system --add safe.directory /workspace/vendor/KAG
# Cloudflare model names start with @; preserve them after the instance ID separator.
COPY docker/kag-api/PatchOpenSpgModelId.java /tmp/PatchOpenSpgModelId.java
RUN python - <<'PY'
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import os
import shutil
import subprocess

archive = Path('/arks-sofaboot-0.0.1-SNAPSHOT-executable.jar')
library = 'BOOT-INF/lib/com.antgroup.openspg.server-infra-dao-0.0.1-SNAPSHOT.jar'
repository = 'com/antgroup/openspg/server/infra/dao/repository/common/UserModelRepositoryImpl.class'
source = Path('/tmp/PatchOpenSpgModelId.java')
with TemporaryDirectory(prefix='openspg-model-id-') as directory:
    work = Path(directory)
    with ZipFile(archive) as boot:
        javassist = work / 'javassist.jar'
        javassist.write_bytes(boot.read('BOOT-INF/lib/javassist-3.19.0-GA.jar'))
        with ZipFile(BytesIO(boot.read(library))) as original:
            bytecode = work / 'UserModelRepositoryImpl.class'
            bytecode.write_bytes(original.read(repository))
            subprocess.run(['javac', '-cp', str(javassist), '-d', directory, str(source)], check=True)
            subprocess.run(['java', '-cp', directory + ':' + str(javassist),
                            'PatchOpenSpgModelId', str(bytecode)], check=True)
            patched_library = BytesIO()
            with ZipFile(patched_library, 'w') as patched:
                for entry in original.infolist():
                    patched.writestr(entry, bytecode.read_bytes() if entry.filename == repository
                                     else original.read(entry))
        output = work / archive.name
        with ZipFile(output, 'w') as patched:
            for entry in boot.infolist():
                if entry.filename == library:
                    patched.writestr(entry, patched_library.getvalue())
                else:
                    with boot.open(entry) as reader, patched.open(entry, 'w') as writer:
                        shutil.copyfileobj(reader, writer)
    os.replace(output, archive)
source.unlink()
PY
RUN mkdir -p /run/kag-locks /builder-runs /provider-state /builder-state /benchmark-data \
    && chmod 1777 /run/kag-locks /builder-runs \
    && chown 10001:10001 /provider-state /builder-state /benchmark-data && chmod 700 /provider-state /builder-state /benchmark-data
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 KAG_DEBUG_DUMP_CONFIG=0 \
    MPLCONFIGDIR=/tmp/matplotlib HOME=/tmp \
    KAG_OPERATIONAL_PROOF=DENY KAG_PRODUCTION_WRITE=BLOCKED KAG_PROVIDER_EGRESS=DENY
EXPOSE 8000
ENTRYPOINT ["python", "-B", "-m", "kag.http_api.server"]
