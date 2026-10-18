"""Four vector targets and bounded one-hop reads on the verified Neo4j DB."""
import json
import re
from urllib.parse import quote
from urllib.request import Request

from kag.builder.codec import canonical_json
from kag.vector_contract import TARGETS, valid_vector as _valid_vector
from kag.verify import Neo4jReadClient, QUERIES


APPROVED = ('hasUnit','hasChild','hasSign','citesUnit','excludesUnit',
            'cites','amends','repeals','implements','consolidates')
READS = {
    'reader_identity': ('SHOW CURRENT USER YIELD user,roles,passwordChangeRequired,suspended '
                        'RETURN user,roles,passwordChangeRequired,suspended'),
    'reader_privileges': 'SHOW USER PRIVILEGES YIELD access,action RETURN access,action',
    'retrieval_vector': ('CALL db.index.vector.queryNodes($index,$k,$vector) YIELD node,score '
                         'WHERE $label IN labels(node) RETURN node.id AS id,score '
                         'ORDER BY score DESC,id'),
    'retrieval_expand': ('MATCH (a)-[r]->(b) WHERE type(r) IN $predicates '
        'AND any(k IN $keys WHERE (k[0] IN labels(a) AND a.id=k[1]) '
        'OR (k[0] IN labels(b) AND b.id=k[1])) '
        'AND any(l IN labels(a) WHERE l IN $labels) AND any(l IN labels(b) WHERE l IN $labels) '
        'RETURN labels(a) AS from_labels,a.id AS from_id,type(r) AS predicate,'
        'labels(b) AS to_labels,b.id AS to_id '
        'ORDER BY from_id,predicate,to_id LIMIT $limit'),
}


def positive_limit(value, maximum=100):
    if type(value) is not int or not 1<=value<=maximum:
        raise ValueError('bounded positive integer required')


class Neo4jRetrievalClient(Neo4jReadClient):
    """No custom-query interface. Inherited verifier statements are read-only."""
    def __init__(self,*args,namespace='VietRoadTraffic',**kwargs):
        super().__init__(*args,**kwargs)
        if not isinstance(namespace,str) or not re.fullmatch('[A-Za-z][A-Za-z0-9_]*',namespace):
            raise ValueError('invalid schema namespace')
        self.namespace = namespace

    def _query(self,name,parameters=None,*,database=None):
        if name in QUERIES:
            return super()._query(name,parameters,database=database)
        target = 'system' if name in ('reader_identity','reader_privileges') else self.database
        if name not in READS or database not in (None,target):
            raise ValueError('unapproved retrieval statement')
        request = Request(self.endpoint+'/db/'+quote(target,safe='')+'/tx/commit',
            data=canonical_json({'statements':[{'statement':READS[name],
                                                'parameters':parameters or {}}]}).encode(),
            headers={'Authorization':self._auth,'Content-Type':'application/json'},method='POST')
        self.read_requests += 1
        try:
            with self._opener.open(request,timeout=self.timeout) as response:
                result = json.load(response)
            if result.get('errors') or len(result['results'])!=1:
                raise ValueError
            table = result['results'][0]
            if any(len(row['row'])!=len(table['columns']) for row in table['data']):
                raise ValueError
            return [dict(zip(table['columns'],row['row'])) for row in table['data']]
        except Exception:
            raise RuntimeError('Retrieval read transport unavailable.') from None

    def vector_search(self,kind,prop,vector,k):
        positive_limit(k)
        if kind not in TARGETS or prop not in dict(TARGETS[kind]) or not _valid_vector(vector,3072):
            raise ValueError('unsupported schema vector target or vector')
        label,field = self.namespace+'.'+kind,dict(TARGETS[kind])[prop]
        indexes = [r for r in self.indexes() if r.get('type')=='VECTOR'
                   and r.get('labelsOrTypes')==[label] and r.get('properties')==[field]]
        if len(indexes)!=1:
            raise ValueError('vector index missing or ambiguous')
        index = indexes[0]
        config = index.get('options',{}).get('indexConfig',{})
        if (index.get('state')!='ONLINE' or type(config.get('vector.dimensions')) is not int
                or config['vector.dimensions']!=3072
                or not isinstance(config.get('vector.similarity_function'), str)
                or config['vector.similarity_function'].lower()!='cosine'):
            raise ValueError('vector index not ONLINE/3072/cosine')
        rows = self._query('retrieval_vector',{'index':index['name'],'label':label,'k':k,'vector':vector})
        return [dict(row,index=index['name']) for row in rows]

    def reader_security(self):
        rows = self._query('reader_identity')
        if len(rows) != 1:
            raise ValueError('unique current reader principal required')
        return rows[0], self._query('reader_privileges')

    def expand(self,keys,predicates,limit):
        positive_limit(limit)
        labels = [self.namespace+'.'+kind for kind in TARGETS]
        if (not predicates or set(predicates)-set(APPROVED)
                or any(len(key)!=2 or key[0] not in labels
                       or not isinstance(key[1],str) or not key[1] for key in keys)):
            raise ValueError('unapproved expansion target or predicate')
        if not keys:
            return []
        rows = self._query('retrieval_expand',{'keys':keys,'predicates':list(predicates),
                                              'labels':labels,'limit':limit})
        result = []
        for row in rows:
            endpoints = []
            for side in ('from','to'):
                matching = [label for label in row[side+'_labels'] if label in labels]
                if len(matching)!=1:
                    raise ValueError('ambiguous expansion entity type')
                endpoints.append([matching[0],row[side+'_id']])
            result.append({'from':endpoints[0],'predicate':row['predicate'],'to':endpoints[1]})
        return result
