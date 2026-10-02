from pathlib import Path
import sys, json, math, re, copy, hashlib, warnings
from datetime import datetime, timedelta
from importlib.metadata import version
import yaml
from openapi_spec_validator import validate
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT=Path(__file__).resolve().parent.parent
API=ROOT/'docs'/'api'; EX=API/'examples'
spec=yaml.safe_load((API/'openapi.yaml').read_text(encoding='utf-8'))
validate(spec)
schema_uri='https://bedlink.example/contract'
root_schema={'$schema':'https://json-schema.org/draft/2020-12/schema',**spec}
registry=Registry().with_resource(schema_uri,Resource.from_contents(root_schema))
checks=0
def check(condition,message):
    global checks
    checks+=1
    assert condition,message
def resolve(node):
    while '$ref' in node:
        path=node['$ref']; check(path.startswith('#/'),'Nonlocal schema reference '+path)
        node=spec
        for part in path[2:].split('/'): node=node[part.replace('~1','/').replace('~0','~')]
    return node
def validator(schema):
    def absolutize(n):
        if isinstance(n,dict):return {k:schema_uri+v if k=='$ref' and v.startswith('#') else absolutize(v) for k,v in n.items()}
        if isinstance(n,list):return [absolutize(x) for x in n]
        return n
    return Draft202012Validator(absolutize(schema),registry=registry,format_checker=FormatChecker())
def dt(x):return datetime.fromisoformat(x.replace('Z','+00:00'))
def walk(x):
    if isinstance(x,dict):
        yield x
        for v in x.values():yield from walk(v)
    if isinstance(x,list):
        for v in x:yield from walk(v)
manifest=json.loads((EX/'_manifest.json').read_text())['exchanges']
operation_ids=[]
for path,methods in spec['paths'].items():
    for method,op in methods.items():
        operation_ids.append(op['operationId'])
        if op['operationId']=='getHealth':
            check(path=='/health' and method=='get' and op['security']==[], 'public liveness only')
            continue
        check(op['security']==[{'bearerAuth':[]}],op['operationId']+' missing security')
        check(bool(op['x-roles']),op['operationId']+' missing roles')
        parameters=[resolve(p) for p in op['parameters']]
        check(set(re.findall(r'\{(.*?)\}',path))=={p['name'] for p in parameters if p['in']=='path'},'path parameter declarations')
        mutation=method!='get' and op['operationId']!='findMatches'
        check(any(p['name']=='Idempotency-Key' and p['required'] for p in parameters)==mutation,'idempotency parameter')
        check({'400','401','403','429','500','503'}<=set(op['responses']),'common error coverage')
        for response in op['responses'].values():
            response=resolve(response)
            check('schema' in response['content']['application/json'],'response schema')
check(len(operation_ids)==len(set(operation_ids))==14,'14 unique operations')
for name,schema in spec['components']['schemas'].items(): Draft202012Validator.check_schema(schema)

payload_count=0; seen_files=set(); seen_ops=set(); key_results={}; loaded={}
for entry in manifest:
    path=entry['pathTemplate'].removeprefix('/api/v1'); method=entry['method'].lower(); op=spec['paths'][path][method]
    check(op['operationId']==entry['operationId'],'manifest operation')
    check(re.fullmatch(re.sub(r'\{[^}]+\}',r'[^/]+',entry['pathTemplate']),entry['path']) is not None,'manifest path')
    seen_ops.add(op['operationId']); req=None
    if 'requestFile' in entry:
        req=json.loads((EX/entry['requestFile']).read_text())
        validator(op['requestBody']['content']['application/json']['schema']).validate(req)
        payload_count+=1; seen_files.add(entry['requestFile'])
    else:check('requestBody' not in op,'missing required fixture request body')
    resp=json.loads((EX/entry['responseFile']).read_text()); loaded[entry['name']]=resp
    response_schema=resolve(op['responses'][str(entry['status'])])['content']['application/json']['schema']
    validator(response_schema).validate(resp); payload_count+=1; seen_files.add(entry['responseFile'])
    now=dt(resp['serverTime'])
    for param in [resolve(x) for x in op['parameters']]:
        if param['in']=='header':
            check(param['name'] in entry['requestHeaders'],'missing header')
            validator(param['schema']).validate(entry['requestHeaders'][param['name']])
    for header,definition in resolve(op['responses'][str(entry['status'])]).get('headers',{}).items():
        if header in entry['responseHeaders']:
            value=entry['responseHeaders'][header]
            if definition['schema'].get('type')=='boolean':value=value=='true'
            validator(definition['schema']).validate(value)
    for d in walk(resp):
        for field in d:
            check(re.match(r'^[a-z][A-Za-z0-9]*$',field) is not None,'non-camelCase payload field '+field)
        if 'activeHoldCount' in d:
            f,h,c,a=d['reportedFreeBeds'],d['activeHoldCount'],d['capacity'],d['availableBeds']
            check(0<=h<=f<=c,'inventory invariant')
            check(a==f-h,'available count')
            check(math.isclose(d['loadRatio'],1-a/c,abs_tol=1e-12),'load ratio')
            p=d['freshnessPolicy']; check(p['agingAfterMinutes']<p['staleAfterMinutes'],'threshold ordering')
            if d['verifiedAt'] is not None:
                age=(now-dt(d['verifiedAt'])).total_seconds()/60
                check(math.isclose(age,d['dataAgeMinutes'],abs_tol=1e-7),'dataAgeMinutes drift: '+entry['name'])
                check(d['freshness']==('fresh' if age<p['agingAfterMinutes'] else 'aging' if age<p['staleAfterMinutes'] else 'stale'),'freshness classification')
                check(dt(d['inventoryUpdatedAt'])<=now,'future inventory change')
        if 'responseDeadlineAt' in d:
            check((dt(d['responseDeadlineAt'])-dt(d['createdAt'])).total_seconds()==120,'deadline duration')
            if d['status']=='pending':check(now<dt(d['responseDeadlineAt']),'pending beyond deadline')
            elif d['status']=='timedOut':check(d['resolvedAt']==d['responseDeadlineAt'] and now>=dt(d['resolvedAt']),'timeout effective time')
            elif d['status'] in ('accepted','rejected'):check(dt(d['createdAt'])<=dt(d['resolvedAt'])<dt(d['responseDeadlineAt']),'late decision')
        if 'expiresAt' in d and 'attemptId' in d:
            check((dt(d['expiresAt'])-dt(d['createdAt'])).total_seconds()==900,'hold duration')
            if d['status']=='active':check(now<dt(d['expiresAt']),'active after expiry')
            elif d['status']=='expired':check(d['endedAt']==d['expiresAt'] and now>=dt(d['endedAt']),'expiry effective time')
            else:check(dt(d['createdAt'])<=dt(d['endedAt'])<dt(d['expiresAt']),'hold ended outside live interval')
        if 'outcome' in d and 'candidates' in d:
            diag=d['diagnostics']; cs=d['candidates']; policy=d['policy']
            check(diag['compatiblePoolCount']==diag['freshPoolCount']+diag['stalePoolCount']+diag['unverifiedPoolCount'],'diagnostics counts')
            check(diag['freshAvailablePoolCount']<=diag['freshPoolCount'],'diagnostic fresh available')
            expected='matchesFound' if cs else 'availabilityOutdated' if diag['stalePoolCount']+diag['unverifiedPoolCount'] else 'capacityUnavailable' if diag['compatiblePoolCount'] else 'noEligibleHospitals'
            check(d['outcome']==expected,'outcome precedence')
            check([c['rank'] for c in cs]==list(range(1,len(cs)+1)),'contiguous ranks')
            check(len({c['hospital']['id'] for c in cs})==len(cs),'one pool per hospital')
            check(cs==sorted(cs,key=lambda c:(-c['score'],c['travel']['estimatedTravelMinutes'],c['hospital']['id'])),'candidate order')
            needs=(req or {}).get('needs') or resp.get('request',{}).get('needs') or {'location':{'latitude':12.970,'longitude':77.600},'resources':['icu','ventilator','oxygen'],'specialty':'cardiac'}
            check(math.isclose(sum(policy[k] for k in ['travelWeight','freshnessWeight','headroomWeight']),1),'weights sum')
            for c in cs:
                p=c['bedPool']; h=c['hospital']; t=c['travel']
                check(p['hospitalId']==h['id'],'pool hospital match')
                check(h['id'] not in diag['excludedHospitalIds'],'excluded candidate')
                check(set(needs['resources'])<=set(p['resources']) and (needs['specialty'] is None or needs['specialty'] in p['specialties']),'requirements together')
                check(p['availableBeds']>=1 and p['freshness'] in ('fresh','aging'),'eligible candidate')
                lat1=math.radians(needs['location']['latitude']); lat2=math.radians(h['location']['latitude'])
                dl=math.radians(h['location']['longitude']-needs['location']['longitude'])
                a=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dl/2)**2
                distance=6371*2*math.asin(min(1,math.sqrt(a)))
                minutes=max(1,math.ceil(distance*policy['simulatedRoadFactor']/policy['simulatedSpeedKph']*60))
                check(t['distanceKm']==round(distance,1) and t['estimatedTravelMinutes']==minutes,'travel calculation')
                components={'travelScore':max(0,100*(1-minutes/policy['travelScoreHorizonMinutes'])),'freshnessScore':max(0,100*(1-p['dataAgeMinutes']/policy['staleAfterMinutes'])),'headroomScore':100*p['availableBeds']/p['capacity']}
                check(all(abs(c['scoreBreakdown'][k]-v)<=0.000051 for k,v in components.items()),'score components')
                score=math.floor((components['travelScore']*policy['travelWeight']+components['freshnessScore']*policy['freshnessWeight']+components['headroomScore']*policy['headroomWeight'])*100+0.5)/100
                check(c['score']==score,'weighted total')
        if 'hospitals' in d:
            check([h['id'] for h in d['hospitals']]==sorted(h['id'] for h in d['hospitals']),'hospital order')
    if 'request' in resp:
        r=resp['request']; attempts=resp['attempts']; holds=resp['holds']
        check(all(a['requestId']==r['id'] for a in attempts),'attempt request IDs')
        check(all(h['requestId']==r['id'] for h in holds),'hold request IDs')
        pending=[a for a in attempts if a['status']=='pending']; active=[h for h in holds if h['status']=='active']
        check(len(pending)+len(active)<=1,'one live commitment')
        check((r['activeAttemptId'] is not None)==bool(pending),'activeAttemptId presence')
        if pending:check(r['activeAttemptId']==pending[0]['id'] and r['status']=='pending','pending linkage')
        check(resp['activeHold']==(active[0] if active else None),'activeHold linkage')
        check(r['activeHoldId']==(active[0]['id'] if active else None),'activeHoldId linkage')
        for h in holds:
            a=next(a for a in attempts if a['id']==h['attemptId'])
            check(a['status']=='accepted' and a['hospitalId']==h['hospitalId'] and a['bedPoolId']==h['bedPoolId'],'accepted hold linkage')
        check((resp['nextBest'] is not None)==(r['status']=='searching'),'fallback state')
        if resp['nextBest'] is not None:check(set(resp['nextBest']['diagnostics']['excludedHospitalIds'])=={a['hospitalId'] for a in attempts},'fallback excludes all attempts')
        check(attempts==sorted(attempts,key=lambda a:(a['createdAt'],a['id'])),'history order')
    key=entry['requestHeaders'].get('Idempotency-Key')
    if key and entry['status']<300:
        identity=(entry['actor'],key)
        fingerprint=(entry['method'],entry['path'],json.dumps(req,sort_keys=True))
        if entry['responseHeaders'].get('Idempotency-Replayed')=='true':
            old=key_results[identity]
            check((fingerprint,entry['status'],resp)==old,'replay result changed')
        else:key_results[identity]=(fingerprint,entry['status'],resp)
check(seen_ops==set(operation_ids)-{'getHealth'},'success coverage of all operations')
check(seen_files=={p.relative_to(EX).as_posix() for p in EX.rglob('*.json') if p.name!='_manifest.json'},'unmapped payload files')
for d in walk(spec):
    if 'externalValue' in d:check((API/d['externalValue']).is_file(),'missing external example')

# Independently assert state transitions across fixtures, including conservation of availability.
win=loaded['01-success/06-accept']; arrived=loaded['01-success/08-arrival']
check(win['bedPool']['reportedFreeBeds']==2 and win['bedPool']['activeHoldCount']==1 and win['bedPool']['availableBeds']==1,'acceptance inventory')
check(arrived['bedPool']['reportedFreeBeds']==1 and arrived['bedPool']['activeHoldCount']==0 and arrived['bedPool']['availableBeds']==1,'arrival inventory')
check(win['bedPool']['verifiedAt']==arrived['bedPool']['verifiedAt'],'arrival verified inventory incorrectly')
check(arrived['bedPool']['version']==win['bedPool']['version']+1,'arrival version')
check(loaded['08-last-bed/05-winner']['bedPool']['availableBeds']==0,'last bed consumed')
check(loaded['08-last-bed/06-loser']['error']['code']=='CAPACITY_UNAVAILABLE','last bed loser conflict')
check(loaded['08-last-bed/07-loser-status']['request']['status']=='pending' and not loaded['08-last-bed/07-loser-status']['holds'],'loser gained hold')
check(loaded['03-timeout/04-fallback-offer']['attempts'][0]['status']=='timedOut','timeout state')
check(loaded['10-hold-expiry/01-expired-status']['request']['status']=='searching','expiry recovery')
check(loaded['11-cancel-hold/01-release']['request']['status']=='searching','release recovery')
check(loaded['12-cancel-request/01-cancel']['request']['status']=='cancelled','cancel terminal')

negative=0
def reject(schema_name,data):
    global negative
    check(not validator({'$ref':'#/components/schemas/'+schema_name}).is_valid(data),'negative accepted '+schema_name)
    negative+=1
reject('Location',{'latitude':91,'longitude':0})
reject('Location',{'latitude':0,'longitude':181})
reject('Location',{'latitude':'12.97','longitude':77.6})
reject('Needs',{'location':{'latitude':0,'longitude':0},'resources':['icu','icu']})
reject('Needs',{'location':{'latitude':0,'longitude':0},'resources':['cardiac']})
reject('Needs',{'location':{'latitude':0,'longitude':0},'resources':[]})
reject('Needs',{'location':{'latitude':0,'longitude':0},'resources':['icu'],'specialty':'unknown'})
reject('Timestamp','2026-10-02T15:30:00+05:30')
reject('Timestamp','2026-02-30T10:00:00Z')
reject('AvailabilityUpdate',{'operation':'update','reportedFreeBeds':1})
reject('AvailabilityUpdate',{'operation':'update','reportedFreeBeds':-1,'version':1})
reject('AvailabilityUpdate',{'operation':'update','reportedFreeBeds':1.5,'version':1})
reject('AvailabilityUpdate',{'operation':'update','reportedFreeBeds':1,'version':0})
reject('AcceptAttempt',{'acceptedAt':'2026-10-02T10:00:00Z'})
reject('CreatePatientRequest',{'patientReference':'ANON_1','needs':{'location':{'latitude':0,'longitude':0},'resources':['icu']},'ownerId':'attacker'})
reject('PatientRequest',{**loaded['01-success/07-status']['request'],'activeHoldId':None})
reject('Hold',{**win['hold'],'endedAt':'2026-10-02T10:01:00Z'})
reject('Attempt',{**win['attempt'],'status':'timed_out'})
reject('MatchResult',{**loaded['01-success/02-matches']['result'],'candidates':[]})
reject('BedPool',{**win['bedPool'],'freshness':'unverified'})
reject('TravelEstimate',{'distanceKm':1,'estimatedTravelMinutes':2,'source':'simulatedDistance','trafficConsidered':True})

result={'openapiVersion':spec['openapi'],'operationCount':len(operation_ids),'schemaCount':len(spec['components']['schemas']),'exchanges':len(manifest),'payloadsValidated':payload_count,'negativeSchemaCases':negative,'semanticAndStructuralAssertions':checks,'validators':{p:version(p) for p in ['openapi-spec-validator','jsonschema','PyYAML']},'limitations':['This checker validates contract fixtures only; run the separate Step 3 HTTP and PostgreSQL suites for implementation checks.','Cross-field business rules were checked against the static fixtures; JSON Schema alone does not prove them.']}

print(json.dumps(result,indent=2))
