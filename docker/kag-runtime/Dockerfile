# Pinned Python 3.10.16 / Linux amd64 base for the KAG SDK.
FROM spg-registry.us-west-1.cr.aliyuncs.com/spg/openspg-server@sha256:fe6708deef9ebb8da8da7b1cb643e83b827769a5be8811961311639aa1f2cb88
COPY requirements.txt requirements-http-api.txt /opt/
RUN python -m venv /opt/kag-venv && /opt/kag-venv/bin/python -m pip install --no-cache-dir --disable-pip-version-check -r /opt/requirements.txt -r /opt/requirements-http-api.txt && /opt/kag-venv/bin/python -m pip check
ENV PATH="/opt/kag-venv/bin:${PATH}" PYTHONDONTWRITEBYTECODE=1 KAG_DEBUG_DUMP_CONFIG=0 MPLCONFIGDIR=/tmp/matplotlib
WORKDIR /workspace
ENTRYPOINT ["python", "-B"]
CMD ["--version"]
