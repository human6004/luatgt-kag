"""Shared content-vector targets and validation; no embedding orchestration."""
import math


TARGETS = {'LegalDocument': (('title', '_title_vector'),),
           'LegalUnit': (('text', '_text_vector'),),
           'TrafficSign': (('ten', '_ten_vector'), ('moTa', '_mo_ta_vector'))}


def valid_vector(vector, dimension):
    return (isinstance(vector, list) and len(vector) == dimension
            and set(map(type, vector)) <= {float, int}
            and all(map(math.isfinite, vector))
            and any(v != 0 for v in vector))
