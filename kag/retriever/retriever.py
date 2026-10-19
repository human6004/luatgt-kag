"""Question embedding -> vector targets -> exact graph evidence, no Solver."""
import math

from kag.builder.codec import canonical_json, decode_properties
from kag.vector_contract import TARGETS, valid_vector as _valid_vector
from kag.retriever.neo4j import APPROVED, positive_limit


class Retriever:
    def __init__(self,reader,embed,contract,*,search_k=10,expansion_limit=50):
        positive_limit(search_k)
        positive_limit(expansion_limit)
        if set(contract['relations'])!=set(APPROVED) or set(contract['node_types'])!=set(TARGETS):
            raise ValueError('retriever requires current three-entity ten-predicate schema')
        if embed is not None and not callable(embed):
            raise ValueError('query embedding callable required')
        self.reader,self.embed,self.contract = reader,embed,contract
        self.search_k,self.expansion_limit = search_k,expansion_limit
        self.namespace = contract['namespace']
        self.dimension = getattr(reader,'dimension',3072)
        if type(self.dimension) is not int or not 1<=self.dimension<=65536:
            raise ValueError('invalid vector dimension')

    def _hydrate(self,keys):
        records = self.reader.read_nodes([list(key) for key in sorted(keys)])
        result = {}
        for record in records:
            kinds = [kind for kind in TARGETS if self.namespace+'.'+kind in record['labels']]
            if len(kinds)!=1:
                raise ValueError('ambiguous evidence entity type')
            kind = kinds[0]
            props = decode_properties(record['properties'],self.contract['node_properties'][kind])
            key = self.namespace+'.'+kind,props['id']
            if key not in keys or key in result or props['name']!=props['id']:
                raise ValueError('missing, duplicate or mismatched exact evidence identity')
            texts = {prop:record['properties'].get(prop,'') for prop,_ in TARGETS[kind]}
            if any(not isinstance(text,str) for text in texts.values()):
                raise ValueError('evidence source text must remain exact Text')
            result[key] = {'entity_type':key[0],'entity_id':key[1],
                'doc_id':props['id'] if kind=='LegalDocument' else props['doc_id'],
                'unit_id':props['id'] if kind=='LegalUnit' else props.get('unit_id'),
                'sign_id':props['id'] if kind=='TrafficSign' else None,
                'source_texts':texts,'score':None,'vector_sources':[],'graph_context':[]}
        if set(result)!=set(keys):
            raise ValueError('exact evidence readback incomplete')
        return result

    def retrieve(self,question,*,top_k=10,expand=False):
        positive_limit(top_k,self.search_k)
        if not isinstance(question,str) or not question.strip() or type(expand) is not bool:
            raise ValueError('nonempty exact question and boolean expansion required')
        if self.embed is None:
            raise ValueError('query embedding callable required')
        return self.retrieve_vector(self.embed(question),top_k=top_k,expand=expand)

    def retrieve_vector(self,vector,*,top_k=10,expand=False):
        positive_limit(top_k,self.search_k)
        if type(expand) is not bool:
            raise ValueError('boolean expansion required')
        if not _valid_vector(vector,self.dimension):
            raise ValueError('query embedding dimension or values invalid')
        hits = {}
        for kind,targets in TARGETS.items():
            for prop,_ in targets:
                rows = self.reader.vector_search(kind,prop,vector,self.search_k) or []
                if len(rows)>self.search_k:
                    raise ValueError('vector result exceeds requested bound')
                for row in rows:
                    identity,score = row.get('id'),row.get('score')
                    if (not isinstance(identity,str) or not identity
                            or type(score) not in (int,float) or not math.isfinite(score)
                            or not 0<=score<=1):
                        raise ValueError('vector result requires exact ID and cosine score in [0,1]')
                    key = self.namespace+'.'+kind,identity
                    source = {'property':prop,'score':score,'index':row.get('index')}
                    previous = hits.setdefault(key,{})
                    if prop not in previous or (score,str(source['index']))>(
                            previous[prop]['score'],str(previous[prop]['index'])):
                        previous[prop] = source
        ranked = sorted(hits,key=lambda key:(-max(s['score'] for s in hits[key].values()),key))[:top_k]
        if not ranked:
            return []
        evidence = self._hydrate(set(ranked))
        for key in ranked:
            sources = sorted(hits[key].values(),key=lambda s:(-s['score'],s['property']))
            evidence[key].update(score=sources[0]['score'],vector_sources=sources)
        if expand:
            relations = self.reader.expand([list(key) for key in ranked],APPROVED,self.expansion_limit)
            if len(relations)>self.expansion_limit:
                raise ValueError('graph expansion exceeds bound')
            contexts = {}
            for relation in relations:
                try:
                    source,target = tuple(relation['from']),tuple(relation['to'])
                    rule = self.contract['relations'][relation['predicate']]
                    expected = self.namespace+'.'+rule['from_type'],self.namespace+'.'+rule['to_type']
                    if (len(source)!=2 or len(target)!=2 or (source[0],target[0])!=expected
                            or not isinstance(source[1],str) or not source[1]
                            or not isinstance(target[1],str) or not target[1]
                            or not (source in evidence or target in evidence)):
                        raise ValueError
                except (KeyError,TypeError,ValueError):
                    raise ValueError('unapproved or disconnected graph relation') from None
                for key in (source,target):
                    contexts.setdefault(key,{})[canonical_json(relation)] = relation
            added = set(contexts)-set(evidence)
            evidence.update(self._hydrate(added) if added else {})
            for key,context in contexts.items():
                evidence[key]['graph_context'] = [context[name] for name in sorted(context)]
            ranked.extend(sorted(added))
        return [evidence[key] for key in ranked]
