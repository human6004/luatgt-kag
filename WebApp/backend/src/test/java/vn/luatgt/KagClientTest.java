package vn.luatgt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.web.server.ResponseStatusException;
import vn.luatgt.integration.KagClient;
import vn.luatgt.service.KagSchema;
import static org.junit.jupiter.api.Assertions.*;

@ExtendWith(OutputCaptureExtension.class)
class KagClientTest {
    @TempDir Path temporary;
    final ObjectMapper json=new ObjectMapper();
    final UUID owner=UUID.fromString("00000000-0000-4000-8000-000000000001");
    static final String TOKEN="t".repeat(43),RELEASE="synthetic-release",SNAPSHOT="synthetic-publication";
    KagSchema schema; Path secret;
    @BeforeEach void setup() throws Exception { schema=new KagSchema(json); secret=temporary.resolve("service.key"); Files.writeString(secret,TOKEN); }
    Map<String,Object> request() { return new HashMap<>(Map.of("user_id",owner,"message","Căn cứ nào?","context_id","","schema_contract",schema.identity())); }
    JsonNode answer() {
        var result=json.createObjectNode().put("answer","Căn cứ nguyên văn 🚦.");
        String quote="Nội dung thử 🚦.";
        result.putArray("citations").addObject().put("doc_id","test").put("unit_id","test::1").putNull("sign_id")
            .put("evidence_id","a".repeat(64)).put("field","text").put("start",0).put("end",quote.codePointCount(0,quote.length())).put("quote",quote);
        return result;
    }
    class Fixture implements AutoCloseable {
        final HttpServer server; final AtomicInteger calls=new AtomicInteger();
        final Map<String,List<String>> headers=new TreeMap<>(String.CASE_INSENSITIVE_ORDER); JsonNode received;
        int status=200,delay; String media="application/json",omit,wrong,duplicate;
        String body=answer().toString(),delta="Nội dung thử",encoding; byte[] raw; boolean incomplete,closeBeforeHeaders,identityHeaders=true;
        String requestId="00000000-0000-4000-8000-000000000002",cacheControl="no-store";
        final AtomicReference<Runnable> onRequest=new AtomicReference<>(()->{});
        Fixture() throws Exception {
            server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.createContext("/v1/query",exchange->{
                calls.incrementAndGet(); headers.clear(); headers.putAll(exchange.getRequestHeaders());
                received=json.readTree(exchange.getRequestBody().readAllBytes());
                onRequest.get().run();
                if(closeBeforeHeaders) { exchange.close(); return; }
                if(delay>0) try { Thread.sleep(delay); } catch(InterruptedException e) { Thread.currentThread().interrupt(); }
                for(String name:List.of("X-KAG-Release-ID",exchange.getRequestHeaders().containsKey("X-KAG-Source-Snapshot-ID")?"X-KAG-Source-Snapshot-ID":"X-WebApp-Snapshot-ID","X-KAG-As-Of")) {
                    if(!identityHeaders) continue;
                    String value=exchange.getRequestHeaders().getFirst(name);
                    if(value==null) value=name.equals("X-KAG-Release-ID")?RELEASE:name.equals("X-WebApp-Snapshot-ID")?SNAPSHOT:LocalDate.now(ZoneId.of("Asia/Saigon")).toString();
                    if(!name.equals(omit)) exchange.getResponseHeaders().add(name,name.equals(wrong)?"wrong":value);
                    if(name.equals(duplicate)) exchange.getResponseHeaders().add(name,value);
                }
                if(requestId!=null) exchange.getResponseHeaders().set("X-Request-ID",requestId);
                if(cacheControl!=null) exchange.getResponseHeaders().set("Cache-Control",cacheControl);
                boolean streaming=status==200&&exchange.getRequestURI().getPath().endsWith("/stream");
                exchange.getResponseHeaders().set("Content-Type",streaming&&media.equals("application/json")?"text/event-stream":media);
                if(encoding!=null) exchange.getResponseHeaders().set("Content-Encoding",encoding);
                byte[] bytes=raw!=null?raw:(streaming?"event: delta\ndata: "+json.createObjectNode().put("text",delta)+"\n\n"+(incomplete?"":"event: done\ndata: "+body+"\n\n"):body).getBytes(java.nio.charset.StandardCharsets.UTF_8);
                try { exchange.sendResponseHeaders(status,bytes.length); try(var out=exchange.getResponseBody()) { out.write(bytes); } }
                catch(java.io.IOException expectedDisconnect) { exchange.close(); }
            });
            server.createContext("/v1/health",exchange->{
                boolean ready=exchange.getRequestURI().getRawQuery()!=null;
                String health=ready?"{\"request_id\":\"00000000-0000-4000-8000-000000000002\",\"error\":{\"code\":\"NOT_READY\",\"message\":\"Dịch vụ chưa sẵn sàng.\",\"retryable\":false},\"native_state\":null,\"status\":\"unavailable\",\"capability\":\"query-v1\",\"checks\":{\"auth\":\"pass\",\"runtime\":\"blocked\",\"sources\":\"unknown\",\"admission\":\"pass\"},\"provider_transport\":\"not_probed\",\"production_write\":\"blocked\"}":"{\"contract_version\":\"h1-read-v1.0\",\"status\":\"alive\"}";
                byte[] bytes=health.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");
                exchange.sendResponseHeaders(ready?503:200,bytes.length);
                try(var out=exchange.getResponseBody()) { out.write(bytes); }
            });
            server.start();
        }
        String url() { return "http://127.0.0.1:"+server.getAddress().getPort(); }
        @Override public void close() { server.stop(0); }
    }
    KagClient client(Fixture f,Map<String,Object> overrides,Clock clock) {
        var properties=new HashMap<String,Object>(Map.of("app.kag-url",f.url(),"app.kag-token-file",secret.toString(),"app.kag-release-id",RELEASE,"app.kag-webapp-snapshot-id",SNAPSHOT));
        properties.putAll(overrides);
        try(var context=new AnnotationConfigApplicationContext()) {
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("synthetic",properties));
            context.registerBean(ObjectMapper.class,()->json); context.registerBean(KagSchema.class,()->schema);
            if(clock!=null) context.registerBean(Clock.class,()->clock);
            context.register(KagClient.class); context.refresh(); return context.getBean(KagClient.class);
        }
    }
    KagClient client(Fixture f) { return client(f,Map.of(),null); }
    @Test void datasetSourcesValidatePinnedReleaseQuoteAndAllDomainTypesWithoutPublication() throws Exception {
        try(var f=new Fixture()) {
            var releaseView=json.createObjectNode().put("contract_version","h1-read-v1.2").put("release_kind","PRODUCTION")
                .put("source_mode","dataset-snapshot-v1").put("release_id",RELEASE).put("source_snapshot_id","dataset-source")
                .putNull("webapp_snapshot_id").put("source_catalog_sha256","a".repeat(64)).put("release_descriptor_sha256","b".repeat(64))
                .put("graph_fingerprint","c".repeat(64)).put("backend_identity_verified",false).put("source_identity_verified",false)
                .putNull("verified_at").put("query_ready",false).put("production_write","blocked");
            releaseView.set("schema_contract",json.valueToTree(schema.identity()));
            f.server.createContext("/v1/graph/release",exchange->{
                byte[] bytes=releaseView.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(200,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var client=client(f);
            for(String kind:List.of("LegalDocument","LegalUnit","TrafficSign")) {
                var result=(com.fasterxml.jackson.databind.node.ObjectNode)answer(); result.put("contract_version","graph-chat-v1");
                var citation=(com.fasterxml.jackson.databind.node.ObjectNode)result.path("citations").get(0);
                String field=kind.equals("LegalUnit")?"text":kind.equals("TrafficSign")?"ten":"title";
                String id=kind.equals("LegalDocument")?"test":kind.equals("LegalUnit")?"test::1":"sign-1";
                if(!kind.equals("LegalUnit"))citation.putNull("unit_id");
                if(kind.equals("TrafficSign"))citation.put("sign_id",id);
                citation.put("field",field);
                String entity=schema.identity().get("namespace")+"."+kind;
                citation.put("evidence_id",HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(List.of(entity,id,field)))));
                var source=citation.putObject("source").put("contract_version","graph-source-v1").put("release_id",RELEASE)
                    .put("source_snapshot_id","dataset-source").put("release_descriptor_sha256","b".repeat(64))
                    .put("entity_type",entity).put("entity_id",id).put("text",citation.path("quote").asText())
                    .put("as_of",LocalDate.now(ZoneId.of("Asia/Saigon")).toString())
                    .put("source_sha256",HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(citation.path("quote").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8))));
                source.set("schema_contract",json.valueToTree(schema.identity()));
                source.putObject("metadata").put("id",id).put("name",id).put("doc_id","test").put(field,citation.path("quote").asText());
                source.putObject("document_metadata").put("id","test").put("name","test").put("title","Văn bản kiểm thử").put("effective_from","2020-01-01");
                f.body=result.toString();assertEquals(result,client.query(request()));
                assertEquals(List.of("dataset-source"),f.headers.get("X-KAG-Source-Snapshot-ID"));
                for(String wrong:List.of("release_id","source_snapshot_id","release_descriptor_sha256","source_sha256","text")) {
                    var bad=result.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)bad.path("citations").get(0).path("source")).put(wrong,"wrong");
                    f.body=bad.toString();unavailable(()->client(f).query(request()));
                }
            }
        }
    }
    @Test void projectCatalogForwardsOnlyNativeCookieAndPreservesProjectIds() throws Exception {
        try(var f=new Fixture()) {
            var builderSecret=temporary.resolve("builder.key");Files.writeString(builderSecret,"b".repeat(43));
            var session=new AtomicReference<String>();var cookie=new AtomicReference<String>();
            var response=json.readTree("""
                {"contract_version":"builder-projects-v1","state":"AVAILABLE","projects":[
                {"project_id":2,"project_name":"Road","namespace":"RoadOne","database":"roadone","state":"AVAILABLE"},
                {"project_id":3,"project_name":"Road","namespace":"RoadOne","database":"roadone","state":"AVAILABLE"}]}
                """);
            f.server.createContext("/v1/builder/projects",exchange->{
                f.calls.incrementAndGet();session.set(exchange.getRequestHeaders().getFirst("X-OpenSPG-Session"));
                cookie.set(exchange.getRequestHeaders().getFirst("Cookie"));
                byte[] bytes=response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");exchange.getResponseHeaders().set("Cache-Control","no-store");
                exchange.sendResponseHeaders(200,bytes.length);try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var client=client(f,Map.of("app.kag-builder-url",f.url(),"app.kag-builder-token-file",builderSecret.toString()),null);
            var request=new org.springframework.mock.web.MockHttpServletRequest();
            request.setCookies(new jakarta.servlet.http.Cookie("unrelated","private"),new jakarta.servlet.http.Cookie("OPEN_SPG_TOKEN","native-session"));
            request.addHeader("X-OpenSPG-Session","forged-session");
            org.springframework.web.context.request.RequestContextHolder.setRequestAttributes(new org.springframework.web.context.request.ServletRequestAttributes(request));
            try {
                assertEquals(response,client.builderProjects());assertEquals("native-session",session.get());assertNull(cookie.get());
                request.setCookies(new jakarta.servlet.http.Cookie("OPEN_SPG_TOKEN","one"),new jakarta.servlet.http.Cookie("OPEN_SPG_TOKEN","two"));
                assertThrows(ResponseStatusException.class,client::builderProjects);assertEquals(1,f.calls.get());
            } finally { org.springframework.web.context.request.RequestContextHolder.resetRequestAttributes(); }
        }
    }
    @Test void builderStructureUsesNativeSessionAndRejectsFalseSuccess() throws Exception {
        try(var f=new Fixture()) {
            var builderSecret=temporary.resolve("builder.key");Files.writeString(builderSecret,"b".repeat(43));
            var response=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("""
                {"contract_version":"builder-structure-v1","state":"NOT_RUN","revision":0,
                 "preview_id":null,"checked_at":null,"can_apply":false,"report":null,"code":null}
                """);
            var session=new AtomicReference<String>();var authorization=new AtomicReference<String>();
            f.server.createContext("/v1/builder/structure",exchange->{
                f.calls.incrementAndGet();session.set(exchange.getRequestHeaders().getFirst("X-OpenSPG-Session"));
                authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                f.received=exchange.getRequestMethod().equals("POST")?json.readTree(exchange.getRequestBody().readAllBytes()):null;
                byte[] bytes=response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");exchange.getResponseHeaders().set("Cache-Control","no-store");
                exchange.sendResponseHeaders(exchange.getRequestMethod().equals("POST")?202:200,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var client=client(f,Map.of("app.kag-builder-url",f.url(),"app.kag-builder-token-file",builderSecret.toString()),null);
            var request=new org.springframework.mock.web.MockHttpServletRequest();
            request.setCookies(new jakarta.servlet.http.Cookie("OPEN_SPG_TOKEN","native-session"));
            org.springframework.web.context.request.RequestContextHolder.setRequestAttributes(new org.springframework.web.context.request.ServletRequestAttributes(request));
            try {
                assertEquals(response,client.builderStructure(null,null));
                assertEquals("native-session",session.get());assertEquals("Bearer "+"b".repeat(43),authorization.get());
                var change=json.readTree("{\"project_id\":2,\"revision\":0}");
                assertEquals(response,client.builderStructure("preview",change));assertEquals(change,f.received);
                assertThrows(ResponseStatusException.class,()->client.builderStructure("apply",change));assertEquals(2,f.calls.get());
                response.put("state","COMPLETE");
                assertEquals(503,assertThrows(ResponseStatusException.class,()->client.builderStructure(null,null)).getStatusCode().value());
                response.put("state","PREVIEW").put("can_apply",true);
                assertEquals(503,assertThrows(ResponseStatusException.class,()->client.builderStructure(null,null)).getStatusCode().value());
                var report=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("""
                    {"target":{"project_id":2,"project_name":"Isolated","namespace":"Road","database":"road"},
                     "database_id":"fixture","dimension":3072,"counts":{"nodes":0,"edges":0},
                     "changes":[{"kind":"type","action":"REMOVE","name":"Road.Person"},{"kind":"type","action":"KEEP","name":"Road.LegalUnit"}],
                     "indexes":[{"label":"Road.LegalDocument","property":"_title_vector","action":"REBUILD"},
                        {"label":"Road.LegalUnit","property":"_text_vector","action":"REBUILD"},
                        {"label":"Road.TrafficSign","property":"_ten_vector","action":"REBUILD"},
                        {"label":"Road.TrafficSign","property":"_mo_ta_vector","action":"REBUILD"}],
                     "conflicts":[],"native_rebuild":[],"code":null,"build_ready":true,"default_types":["Road.Person"],
                     "index_changes":[{"name":"_road_person_name_vector_index","type":"VECTOR","labels":["Road.Person"],"properties":["_name_vector"],"action":"REMOVE"},
                        {"name":"_road_legal_unit_name_vector_index","type":"VECTOR","labels":["Road.LegalUnit"],"properties":["_name_vector"],"action":"ADD"}]}
                    """);
                response.set("report",report);response.put("preview_id","a".repeat(64));
                assertEquals(response,client.builderStructure(null,null));
                response.put("state","COMPLETE");
                assertEquals(503,assertThrows(ResponseStatusException.class,()->client.builderStructure(null,null)).getStatusCode().value());
                report.putArray("default_types");report.putArray("index_changes");report.putArray("changes").addObject().put("kind","type").put("action","KEEP").put("name","Road.LegalUnit");
                report.path("indexes").forEach(row->((com.fasterxml.jackson.databind.node.ObjectNode)row).put("action","KEEP"));
                response.put("can_apply",false);
                assertEquals(response,client.builderStructure(null,null));
                var clear=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("""
                    {"contract_version":"builder-clear-v1","state":"PREVIEW","revision":1,"preview_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                     "checked_at":"2026-10-18T00:00:00Z","code":null,"deleted":{"nodes":0,"edges":0},
                     "report":{"target":{"project_id":2,"project_name":"Isolated","namespace":"Road","database":"road"},"database_id":"fixture","counts":{"nodes":3,"edges":1},"batch_size":500}}
                    """);
                f.server.createContext("/v1/builder/clear",exchange->{
                    assertEquals("native-session",exchange.getRequestHeaders().getFirst("X-OpenSPG-Session"));
                    assertEquals("Bearer "+"b".repeat(43),exchange.getRequestHeaders().getFirst("Authorization"));
                    f.received=exchange.getRequestMethod().equals("POST")?json.readTree(exchange.getRequestBody().readAllBytes()):null;
                    byte[] bytes=clear.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(exchange.getRequestMethod().equals("POST")?202:200,bytes.length);
                    try(var out=exchange.getResponseBody()){out.write(bytes);}
                });
                assertEquals(clear,client.builderClear(null,null));
                var deletion=json.createObjectNode().put("revision",1).put("preview_id","a".repeat(64)).put("database","road");
                assertEquals(clear,client.builderClear("apply",deletion));assertEquals(deletion,f.received);
                deletion.put("database","../other");
                assertEquals(400,assertThrows(ResponseStatusException.class,()->client.builderClear("apply",deletion)).getStatusCode().value());
                clear.putNull("report");
                assertEquals(503,assertThrows(ResponseStatusException.class,()->client.builderClear(null,null)).getStatusCode().value());
            } finally {org.springframework.web.context.request.RequestContextHolder.resetRequestAttributes();}
        }
    }
    @Test void modelMetadataAcceptsSeparateBuilderAndLegacyWorker() throws Exception {
        try(var f=new Fixture()) {
            var response=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("""
                {"contract_version":"llm-credentials-v3","revision":0,"saved":false,"chat":null,"embedding":null,
                 "applied":false,"connection_tested":false,"save_allowed":true,"error_code":null,"roles":{},
                 "build_config":{"state":"SEPARATE","reason":"BUILDER_CONFIGURATION_API"}}
                """);
            var role=json.readTree("""
                {"saved_revision":null,"active_revision":null,"active":null,"test":null,"status":"NOT_CONFIGURED",
                 "blocker":null,"actions":{"test":false,"apply":false}}
                """);
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("roles")).set("chat",role);
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("roles")).set("embedding",role);
            f.server.createContext("/v1/config/models",exchange->{
                byte[] bytes=response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Cache-Control","no-store");
                exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(200,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var inspectionSecret=temporary.resolve("model-inspection.key");Files.writeString(inspectionSecret,"i".repeat(43));
            var client=client(f,Map.of("app.kag-inspect-token-file",inspectionSecret.toString()),null);
            assertEquals(response,client.llmCredentials(null));
            response.set("build_config",json.valueToTree(Map.of("state","NOT_SUPPORTED","reason","BUILDER_REPLAY_ONLY")));
            assertEquals(response,client.llmCredentials(null));
            response.set("build_config",json.valueToTree(Map.of("state","SEPARATE","reason","BUILDER_REPLAY_ONLY")));
            assertEquals(503,assertThrows(ResponseStatusException.class,()->client.llmCredentials(null)).getStatusCode().value());
        }
    }
    @Test void builderV2ResultBindsRunTargetAndCompletedVerification() throws Exception {
        try(var f=new Fixture()) {
            var builderSecret=temporary.resolve("builder.key");Files.writeString(builderSecret,"b".repeat(43));
            var response=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("""
                {"contract_version":"builder-control-v2","state":"COMPLETE","run_id":"run-1",
                 "target":{"project_id":37,"database":"traffic-full","namespace":"VietRoadTraffic"},
                 "progress":{"stage":"release","done":1,"total":1},"error_code":null,
                 "actions":{"build":false,"stop":false,"resume":false,"delete":false},"delete_reason":"DELETE_NOT_AUTHORIZED","production_write":"CONFIGURED",
                 "stages":[],"timing":{"started_at":"2026-10-17T00:00:00+00:00","updated_at":"2026-10-17T01:00:00+00:00"},
                 "binding":{"run_id":"run-1","scope":"PRODUCTION","plan_sha256":"%s","config_sha256":"%s","model_identity":"https://embedding.invalid/v1|example-model","database_id":"physical-db","project_id":37,"database":"traffic-full","namespace":"VietRoadTraffic"},
                 "result":{"nodes":3,"edges":1,"vectors":2,"dimension":3072,"indexes":4,"fingerprint":"%s","verified_at":"2026-10-17T01:00:00+00:00","chat_activation":"SEPARATE"}}
                """.formatted("a".repeat(64),"d".repeat(64),"c".repeat(64)));
            for(String name:List.of("preflight","plan","vectorize","export-artifact","write-nodes","verify-nodes","write-edges","verify","release"))
                response.withArray("stages").addObject().put("name",name).put("state","COMPLETE").put("done",1).put("total",1).putNull("error_code");
            var revision=new AtomicReference<String>();
            for(String endpoint:List.of("status","build","abandon"))f.server.createContext("/v1/builder/"+endpoint,exchange->{
                assertEquals("Bearer "+"b".repeat(43),exchange.getRequestHeaders().getFirst("Authorization"));
                revision.set(exchange.getRequestHeaders().getFirst("If-Match"));
                byte[] bytes=response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(endpoint.equals("status")?200:202,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var client=client(f,Map.of("app.kag-builder-url",f.url(),"app.kag-builder-token-file",builderSecret.toString()),null);
            assertEquals(response,client.builderStatus());
            assertEquals(response,client.builderAction("build","run-1","\"7\""));assertEquals("\"7\"",revision.get());
            var original=response.deepCopy();
            for(String invalid:List.of("run","target","stage","verification","dimension","secret","missing")) {
                response.removeAll();response.setAll(original.deepCopy());
                var binding=(com.fasterxml.jackson.databind.node.ObjectNode)response.path("binding");
                switch(invalid) {
                    case "run"->binding.put("run_id","foreign");case "target"->binding.put("database","foreign");
                    case "stage"->((com.fasterxml.jackson.databind.node.ObjectNode)response.path("stages").get(1)).put("name","unknown");
                    case "verification"->((com.fasterxml.jackson.databind.node.ObjectNode)response.path("stages").get(7)).put("state","RUNNING");
                    case "dimension"->((com.fasterxml.jackson.databind.node.ObjectNode)response.path("result")).put("dimension","3072");
                    case "secret"->binding.put("api_key","secret");case "missing"->response.putNull("result");
                }
                assertEquals(503,assertThrows(ResponseStatusException.class,client::builderStatus).getStatusCode().value(),invalid);
            }
            response.removeAll();response.setAll(original.deepCopy());
            response.put("contract_version","builder-control-v3").put("state","ABANDONED").putNull("result");
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("actions")).put("abandon",false);
            assertEquals(response,client.builderAction("abandon","run-1","\"7\""));
            assertEquals("\"7\"",revision.get());
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("actions")).put("resume",true);
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderStatus).getStatusCode().value());
        }
    }
    @Test void builderConfigurationUsesDedicatedTokenAndStrictContracts() throws Exception {
        try(var f=new Fixture()) {
            var builderSecret=temporary.resolve("builder.key");Files.writeString(builderSecret,"b".repeat(43));
            var response=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("""
                {"contract_version":"builder-configuration-v1","revision":1,"saved":true,"error_code":null,
                 "target":{"project_id":37,"project_name":"TrafficFull","database":"traffic-full","namespace":"VietRoadTraffic"},
                 "embedding":{"provider":"openai-compatible","base_url":"https://embedding.invalid/v1","model":"example-model","revision":5,"key_configured":true,"tested":true,"dimension":3072},
                 "batch_size":64,"request_limit":null,"readiness":{"state":"NOT_RUN","checks":[],"checked_at":null}}
                """);
            var method=new AtomicReference<String>();var payload=new AtomicReference<String>();
            var saveDelay=new AtomicInteger();
            var calls=new AtomicInteger();
            for(String path:List.of("configuration","preflight"))f.server.createContext("/v1/builder/"+path,exchange->{
                calls.incrementAndGet();method.set(exchange.getRequestMethod());payload.set(new String(exchange.getRequestBody().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
                if(method.get().equals("POST")&&saveDelay.get()>0)try{Thread.sleep(saveDelay.get());}catch(InterruptedException e){Thread.currentThread().interrupt();}
                assertEquals("Bearer "+"b".repeat(43),exchange.getRequestHeaders().getFirst("Authorization"));
                byte[] bytes=response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");
                exchange.sendResponseHeaders(method.get().equals("POST")?202:200,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var client=client(f,Map.of("app.kag-builder-url",f.url(),"app.kag-builder-token-file",builderSecret.toString()),null);
            assertEquals(response,client.builderConfiguration());assertEquals("GET",method.get());
            var change=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree("{\"revision\":0,\"embedding_revision\":5,\"batch_size\":64,\"request_limit\":null}");
            assertEquals(response,client.saveBuilderConfiguration(change));assertEquals(change,json.readTree(payload.get()));
            assertEquals(response,client.checkBuilderReadiness());assertEquals("{}",payload.get());
            var readiness=(com.fasterxml.jackson.databind.node.ObjectNode)response.path("readiness");
            readiness.put("state","BLOCKED");
            var checks=readiness.putArray("checks");
            checks.addObject().put("name","target").put("state","BLOCKED").put("code","INDEX");
            var lock=checks.addObject().put("name","lock").put("state","NOT_CHECKED").put("code","WAIT_TARGET");
            assertEquals(response,client.builderConfiguration());
            lock.put("state","BLOCKED").put("code","LOCK");
            assertEquals(response,client.builderConfiguration());
            var owner=lock.putObject("owner").put("run_id","build-related").put("project_id",2);
            assertEquals(response,client.builderConfiguration());
            owner.put("owner_token","secret");
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());
            owner.remove("owner_token");owner.put("project_id",-1);
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());
            owner.put("project_id",2).put("run_id",123);
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());
            lock.remove("owner");
            lock.put("state","NOT_CHECKED").put("code","CONFIG");
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());
            readiness.put("state","NOT_RUN");readiness.putArray("checks");
            response.put("contract_version","builder-configuration-v2");
            var selection=response.putObject("selection");selection.put("node_limit",32).put("nodes",32).put("edges",21);
            change.put("node_limit",32);
            saveDelay.set(3500);
            assertEquals(response,client.saveBuilderConfiguration(change));assertEquals(change,json.readTree(payload.get()));
            saveDelay.set(0);
            change.put("node_limit",129);
            assertEquals(400,assertThrows(ResponseStatusException.class,()->client.saveBuilderConfiguration(change)).getStatusCode().value());
            change.put("node_limit",32);selection.put("nodes",33);
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());
            selection.put("nodes",32);
            response.put("contract_version","builder-configuration-v4").putNull("links");
            selection.put("node_limit",151).put("nodes",151).put("edges",299);
            var scopeRequest=selection.putObject("request").put("mode","PERCENT").put("value",50);
            var summary=selection.putObject("summary").put("nodes",151).put("edges",299).put("excluded_edges",12);
            summary.putObject("node_counts").put("LegalDocument",1).put("LegalUnit",149).put("TrafficSign",1);
            summary.putObject("edge_counts").put("hasUnit",299);
            assertEquals(response,client.builderConfiguration());
            change.remove("node_limit");change.put("selection_preview_id","e".repeat(64));
            assertEquals(response,client.saveBuilderConfiguration(change));
            var preview=json.createObjectNode().put("contract_version","builder-selection-v1").put("revision",0).put("preview_id","e".repeat(64)).put("node_limit",151);
            preview.set("request",scopeRequest);preview.set("summary",summary);
            f.server.createContext("/v1/builder/selection",exchange->{
                assertEquals("POST",exchange.getRequestMethod());
                assertEquals("Bearer "+"b".repeat(43),exchange.getRequestHeaders().getFirst("Authorization"));
                byte[] bytes=preview.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(202,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var request=json.createObjectNode().put("revision",0).put("mode","PERCENT").put("value",50);
            assertEquals(preview,client.previewBuilderSelection(request));
            summary.put("nodes",150);
            assertEquals(503,assertThrows(ResponseStatusException.class,()->client.previewBuilderSelection(request)).getStatusCode().value());
            summary.put("nodes",151);request.put("value",101);
            assertEquals(400,assertThrows(ResponseStatusException.class,()->client.previewBuilderSelection(request)).getStatusCode().value());
            int before=calls.get();change.put("endpoint","http://localhost");
            assertEquals(400,assertThrows(ResponseStatusException.class,()->client.saveBuilderConfiguration(change)).getStatusCode().value());
            assertEquals(before,calls.get());
            response.put("api_key","forbidden");
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());response.remove("api_key");
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("readiness")).put("state","READY");
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderConfiguration).getStatusCode().value());
        }
    }
    @Test void fullBuilderSourceProofDoesNotBecomeTargetPreflight() throws Exception {
        try(var f=new Fixture()) {
            var builderSecret=temporary.resolve("builder.key");Files.writeString(builderSecret,"b".repeat(43));
            var response=json.readTree("""
                {"contract_version":"builder-inputs-v1","configuration":"CONFIGURED","error_code":null,
                 "scope":"PRODUCTION","target":{"project_id":37,"database":"traffic-full","namespace":"VietRoadTraffic"},
                 "inputs":[{"name":"c3_manifest","sha256":"%s","state":"NOT_CHECKED"}],"preflight":"NOT_RUN",
                 "source_validation":{"state":"VALID","error_code":null,"plan_sha256":"%s","nodes":3,"edges":1}}
                """.formatted("a".repeat(64),"f".repeat(64)));
            var method=new AtomicReference<String>();var payload=new AtomicReference<String>();
            f.server.createContext("/v1/builder/inputs",exchange->{
                method.set(exchange.getRequestMethod());payload.set(new String(exchange.getRequestBody().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
                assertEquals("Bearer "+"b".repeat(43),exchange.getRequestHeaders().getFirst("Authorization"));
                byte[] bytes=response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type","application/json");
                exchange.getResponseHeaders().set("Cache-Control","no-store");
                exchange.sendResponseHeaders(method.get().equals("POST")?202:200,bytes.length);
                try(var out=exchange.getResponseBody()){out.write(bytes);}
            });
            var client=client(f,Map.of("app.kag-builder-url",f.url(),"app.kag-builder-token-file",builderSecret.toString()),null);
            assertEquals(response,client.builderInputs());
            assertEquals("GET",method.get());
            var product=(com.fasterxml.jackson.databind.node.ObjectNode)response;
            product.put("contract_version","builder-inputs-v2").put("configuration","NOT_CONFIGURED").putNull("scope").putNull("target");
            product.putArray("inputs");
            assertEquals(response,client.builderInputs());
            product.put("contract_version","builder-inputs-v1");
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderInputs).getStatusCode().value());
            product.put("contract_version","builder-inputs-v2");
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("source_validation")).put("state","CHECKING").putNull("plan_sha256").putNull("nodes").putNull("edges");
            assertEquals(response,client.checkBuilderInputs());
            assertEquals("POST",method.get());assertEquals("{}",payload.get());
            ((com.fasterxml.jackson.databind.node.ObjectNode)response.path("source_validation")).put("state","INVALID");
            assertEquals(503,assertThrows(ResponseStatusException.class,client::builderInputs).getStatusCode().value());
        }
    }
    void unavailable(org.junit.jupiter.api.function.Executable call) {
        var error=assertThrows(ResponseStatusException.class,call);
        assertEquals(503,error.getStatusCode().value()); assertEquals("Dịch vụ KAG chưa khả dụng",error.getReason());
        assertNull(error.getCause()); assertFalse(error.toString().contains(TOKEN)); assertFalse(error.toString().contains(secret.toString()));
    }
    @Test void transportReadsRestAndSseAndRejectsIncompleteStream() throws Exception {
        try(var f=new Fixture()) {
            var client=client(f); assertEquals(answer(),client.query(request()));
            var events=new ArrayList<String>(); client.stream(request(),(event,data)->events.add(event));
            assertEquals(List.of("delta","done"),events); f.incomplete=true;
            unavailable(()->client.stream(request(),(event,data)->{}));
        }
    }
    @Test void serviceBearerAndPinsUseOnlyServerConfiguration() throws Exception {
        try(var f=new Fixture()) {
            assertEquals(answer(),client(f).query(request()));
            assertTrue(List.of("Bearer "+TOKEN).equals(f.headers.get("Authorization")));
            assertEquals(List.of(RELEASE),f.headers.get("X-kag-release-id"));
            assertEquals(List.of(SNAPSHOT),f.headers.get("X-webapp-snapshot-id"));
            assertEquals(List.of(LocalDate.now().toString()),f.headers.get("X-kag-as-of"));
            assertEquals(owner.toString(),f.received.path("user_id").asText());
            assertEquals(json.valueToTree(schema.identity()),f.received.path("schema_contract"));
            assertEquals(Set.of("user_id","message","context_id","schema_contract"),fields(f.received));
            assertFalse(f.received.toString().contains(TOKEN));
        }
    }
    static Set<String> fields(JsonNode n) { var fields=new HashSet<String>(); n.fieldNames().forEachRemaining(fields::add); return fields; }
    @Test void secretRotationReloadsOnlyConfiguredFileWithoutRetry() throws Exception {
        try(var f=new Fixture()) {
            var client=client(f); client.query(request()); Files.writeString(secret,"u".repeat(43)); client.query(request());
            assertTrue(List.of("Bearer "+"u".repeat(43)).equals(f.headers.get("Authorization"))); assertEquals(2,f.calls.get());
        }
    }
    @ParameterizedTest @ValueSource(strings={"", "\n", "\r\n"})
    void oneSecretTerminatorMatchesH1WithoutChangingBearer(String terminator) throws Exception {
        Files.writeString(secret,TOKEN+terminator);
        try(var f=new Fixture()) {
            var client=client(f); assertEquals(answer(),client.query(request()));
            assertEquals(List.of("Bearer "+TOKEN),f.headers.get("Authorization"));
            var events=new ArrayList<String>(); client.stream(request(),(event,data)->events.add(event));
            assertEquals(List.of("delta","done"),events);
            assertEquals(List.of("Bearer "+TOKEN),f.headers.get("Authorization"));
        }
    }
    @ParameterizedTest @ValueSource(strings={"", "\n", "\r\n"})
    void secretPayloadBoundaryCannotBeBypassedByTerminator(String terminator) throws Exception {
        Files.writeString(secret,"t".repeat(512)+terminator);
        try(var f=new Fixture()) {
            assertEquals(answer(),client(f).query(request()));
            assertEquals(List.of("Bearer "+"t".repeat(512)),f.headers.get("Authorization"));
        }
        Files.writeString(secret,"t".repeat(513)+terminator);
        try(var f=new Fixture()) { unavailable(()->client(f).query(request())); assertEquals(0,f.calls.get()); }
    }
    @ParameterizedTest @ValueSource(strings={"app.kag-token-file","app.kag-release-id","app.kag-webapp-snapshot-id"})
    void missingConfigurationFailsBeforeHttp(String property) throws Exception {
        try(var f=new Fixture()) { var client=client(f,Map.of(property,""),null); unavailable(()->client.query(request())); assertEquals(0,f.calls.get()); }
    }
    @Test void missingSecretFailsBeforeHttp() throws Exception {
        Files.delete(secret); try(var f=new Fixture()) { unavailable(()->client(f).query(request())); assertEquals(0,f.calls.get()); }
    }
    @Test void unreadableSecretFailsBeforeHttp() throws Exception {
        var view=Files.getFileAttributeView(secret,AclFileAttributeView.class);
        if(view==null) {
            var original=Files.getPosixFilePermissions(secret);
            Files.setPosixFilePermissions(secret,Set.of());
            try(var f=new Fixture()) { unavailable(()->client(f).query(request())); assertEquals(0,f.calls.get()); }
            finally { Files.setPosixFilePermissions(secret,original); }
            return;
        }
        var original=view.getAcl(); var denied=new ArrayList<AclEntry>();
        denied.add(AclEntry.newBuilder().setType(AclEntryType.DENY).setPrincipal(view.getOwner()).setPermissions(AclEntryPermission.READ_DATA).build()); denied.addAll(original);
        view.setAcl(denied);
        try(var f=new Fixture()) { unavailable(()->client(f).query(request())); assertEquals(0,f.calls.get()); }
        finally { view.setAcl(original); }
    }
    @ParameterizedTest @ValueSource(strings={"short","double-newline","embedded-newline","carriage-return","nul","bom","long","nonascii"})
    void invalidSecretFailsBeforeHttp(String mode) throws Exception {
        Files.writeString(secret,switch(mode) { case "short"->"x"; case "double-newline"->TOKEN+"\n\n"; case "embedded-newline"->TOKEN+"\nx"; case "carriage-return"->TOKEN+"\r"; case "nul"->TOKEN+"\0"; case "bom"->"\ufeff"+TOKEN; case "long"->"x".repeat(513); default->"é".repeat(43); });
        try(var f=new Fixture()) { unavailable(()->client(f).query(request())); assertEquals(0,f.calls.get()); }
    }
    @ParameterizedTest @ValueSource(strings={"user_id","schema_contract","message","context_id","Authorization"})
    void invalidOrBrowserControlledRequestRejectedBeforeHttp(String field) throws Exception {
        var request=request(); request.put(field,switch(field) { case "user_id"->owner.toString().toUpperCase(Locale.ROOT); case "schema_contract"->Map.of("namespace","fake"); case "message"->"\ud800"; case "context_id"->"unsupported"; default->"Bearer forged-browser-token"; });
        try(var f=new Fixture()) { unavailable(()->client(f).query(request)); assertEquals(0,f.calls.get()); }
    }
    @ParameterizedTest @ValueSource(strings={"namespace","schema_sha256","contract_sha256"})
    void alteredSchemaIdentityRejectedBeforeHttp(String field) throws Exception {
        var identity=new HashMap<>(schema.identity()); identity.put(field,"wrong"); var request=request(); request.put("schema_contract",identity);
        try(var f=new Fixture()) { unavailable(()->client(f).query(request)); assertEquals(0,f.calls.get()); }
    }
    @ParameterizedTest @ValueSource(strings={"X-KAG-Release-ID","X-WebApp-Snapshot-ID","X-KAG-As-Of"})
    void missingWrongDuplicateEchoRejectedBeforeBodyOrConsumer(String header) throws Exception {
        for(String mode:List.of("missing","wrong","duplicate")) try(var f=new Fixture()) {
            if(mode.equals("missing")) f.omit=header; else if(mode.equals("wrong")) f.wrong=header; else f.duplicate=header;
            var client=client(f); unavailable(()->client.query(request())); var events=new AtomicInteger();
            unavailable(()->client.stream(request(),(event,data)->events.incrementAndGet())); assertEquals(0,events.get());
        }
    }
    @Test void dateRolloverRejectsOldEchoEvenAfterSuccessfulHttp() throws Exception {
        var instant=new AtomicReference<>(Instant.now());
        Clock clock=new Clock() { public ZoneId getZone(){return ZoneId.of("Asia/Saigon");} public Clock withZone(ZoneId zone){return this;} public Instant instant(){return instant.get();} };
        try(var f=new Fixture()) { f.onRequest.set(()->instant.updateAndGet(value->value.plus(Duration.ofDays(1)))); unavailable(()->client(f,Map.of(),clock).query(request())); }
    }
    @Test void wrongJvmTimezoneFailsClosed() throws Exception {
        var old=TimeZone.getDefault(); TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        try(var f=new Fixture()) { unavailable(()->client(f).query(request())); assertEquals(0,f.calls.get()); }
        finally { TimeZone.setDefault(old); }
    }
    @ParameterizedTest @ValueSource(strings={"{}","{\"answer\":\"x\"}","{\"answer\":\"x\",\"citations\":[]}","null","[]","{\"answer\":\"x\",\"answer\":\"y\",\"citations\":[]}","NaN","{\"answer\":\"x\",\"citations\":[]} {}"})
    void malformedOrEmptyResultRejected(String body) throws Exception {
        try(var f=new Fixture()) { f.body=body; unavailable(()->client(f).query(request())); }
    }
    @ParameterizedTest @ValueSource(strings={"quote","unit_id","doc_id","field","sign_id","start","extra"})
    void invalidCitationCannotBeRepairedOrDropped(String field) throws Exception {
        var body=(com.fasterxml.jackson.databind.node.ObjectNode)answer(); var citation=(com.fasterxml.jackson.databind.node.ObjectNode)body.path("citations").get(0);
        if(field.equals("start")) citation.put(field,-1); else if(field.equals("sign_id")) citation.put(field,"sign-only"); else if(field.equals("field")) citation.put(field,"title");
        else if(field.equals("extra")) citation.put(field,true); else citation.putNull(field);
        try(var f=new Fixture()) { f.body=body.toString(); unavailable(()->client(f).query(request())); }
    }
    @Test void exactEveryCitationAndUtf16LimitsArePreserved() throws Exception {
        var body=(com.fasterxml.jackson.databind.node.ObjectNode)answer(); body.put("answer","🚦".repeat(10000));
        var citations=(com.fasterxml.jackson.databind.node.ArrayNode)body.path("citations"); citations.add(citations.get(0).deepCopy());
        try(var f=new Fixture()) { f.body=body.toString(); assertEquals(body,client(f).query(request())); body.put("answer","🚦".repeat(10000)+"x"); f.body=body.toString(); unavailable(()->client(f).query(request())); }
    }
    @Test void responseByteCapRemainsExactly256KiB() throws Exception {
        try(var f=new Fixture()) { int size=f.body.getBytes(java.nio.charset.StandardCharsets.UTF_8).length; f.body+=" ".repeat(256*1024-size);
            var client=client(f); assertEquals(answer(),client.query(request())); f.body+=" "; unavailable(()->client.query(request())); }
    }
    @ParameterizedTest @ValueSource(strings={"text/plain","application/json; charset=iso-8859-1","application/xml"})
    void unsupportedResponseMediaRejected(String media) throws Exception { try(var f=new Fixture()) { f.media=media; unavailable(()->client(f).query(request())); } }
    @ParameterizedTest @ValueSource(ints={401,403,409,422,429,500,502,503,504})
    void allNon2xxRemainGeneric503WithoutParsingNativeErrors(int status) throws Exception {
        for(String code:List.of("KAG_ABSTAINED","V1_RESULT_UNREPRESENTABLE")) try(var f=new Fixture()) {
            f.status=status; f.body="{\"code\":\""+code+"\",\"answer\":\"fabricated\",\"secret\":\""+TOKEN+"\"}";
            unavailable(()->client(f).query(request())); assertEquals(1,f.calls.get());
        }
    }
    static String h1Failure(int status) {
        String code=switch(status) { case 401->"AUTH_INVALID"; case 403->"SCOPE_DENIED"; case 422->"INVALID_REQUEST"; default->"RELEASE_UNAVAILABLE"; };
        String message=switch(status) { case 401->"Xác thực dịch vụ không hợp lệ."; case 403->"Quyền dịch vụ không được phép."; case 422->"Yêu cầu không hợp lệ."; default->"Release chưa khả dụng."; };
        return "{\"request_id\":\"00000000-0000-4000-8000-000000000002\",\"error\":{\"code\":\""+code+"\",\"message\":\""+message+"\",\"retryable\":false},\"native_state\":null}";
    }
    static String nativeAbstention() {
        return "{\"request_id\":\"00000000-0000-4000-8000-000000000002\",\"error\":{\"code\":\"KAG_ABSTAINED\",\"message\":\"Chưa đủ bằng chứng để trả lời.\",\"retryable\":false},\"native_state\":\"abstained\"}";
    }
    @Test void verifiedNativeAbstentionIsTerminalRestAndSseOutcomeWithoutRetryOrCircuitFailure() throws Exception {
        try(var f=new Fixture()) {
            f.status=503; f.body=nativeAbstention(); f.identityHeaders=false; var client=client(f);
            var expected=json.readTree("{\"state\":\"KAG_ABSTAINED\"}");
            for(int i=0;i<5;i++) assertEquals(expected,client.query(request()));
            var events=new ArrayList<String>(); var payloads=new ArrayList<JsonNode>();
            client.stream(request(),(event,data)->{events.add(event);payloads.add(data);});
            assertEquals(List.of("done"),events); assertEquals(List.of(expected),payloads); assertEquals(6,f.calls.get());
        }
    }
    @ParameterizedTest @ValueSource(strings={"http200","http403","code","state","missing-state","extra","answer","retry","message","id","id-echo","missing-id-echo","cache","media","encoding","utf8","duplicate","trailing","empty","token","wrong-release","wrong-snapshot","wrong-date","duplicate-release"})
    void unverifiedAbstentionCannotBecomeBusinessOutcome(String mode) throws Exception {
        try(var f=new Fixture()) {
            f.status=503; var body=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(nativeAbstention());
            var error=(com.fasterxml.jackson.databind.node.ObjectNode)body.path("error");
            switch(mode) {
                case "http200" -> { f.status=200; f.media="application/json; charset=utf-8"; }
                case "http403" -> f.status=403;
                case "code" -> error.put("code","BACKEND_UNAVAILABLE");
                case "state" -> body.put("native_state","answered");
                case "missing-state" -> body.remove("native_state");
                case "extra" -> body.put("reason","out_of_scope");
                case "answer" -> body.put("answer","fabricated");
                case "retry" -> error.put("retryable",true);
                case "message" -> error.putNull("message");
                case "id" -> body.put("request_id","bad");
                case "id-echo" -> f.requestId="00000000-0000-4000-8000-000000000003";
                case "missing-id-echo" -> f.requestId=null;
                case "cache" -> f.cacheControl="public";
                case "media" -> f.media="text/plain";
                case "encoding" -> f.encoding="gzip";
                case "utf8" -> f.raw=new byte[]{(byte)0xc3,0x28};
                case "token" -> error.put("message",TOKEN);
                case "wrong-release" -> f.wrong="X-KAG-Release-ID";
                case "wrong-snapshot" -> f.wrong="X-WebApp-Snapshot-ID";
                case "wrong-date" -> f.wrong="X-KAG-As-Of";
                case "duplicate-release" -> f.duplicate="X-KAG-Release-ID";
            }
            f.body=switch(mode) {case "duplicate"->"{\"native_state\":\"abstained\","+body.toString().substring(1);case "trailing"->body+" {}";case "empty"->"";default->body.toString();};
            var client=client(f); unavailable(()->client.query(request()));
            var events=new ArrayList<String>(); unavailable(()->client.stream(request(),(event,data)->events.add(event)));
            assertTrue(events.isEmpty()); assertEquals(2,f.calls.get());
        }
    }
    @ParameterizedTest @ValueSource(ints={401,403,422,503})
    void h1ErrorsRemainSanitizedAndNeverEmitStreamSuccess(int status,CapturedOutput output) throws Exception {
        String bearer=status==401||status==403?"u".repeat(43):TOKEN;
        Files.writeString(secret,bearer);
        try(var f=new Fixture()) {
            f.status=status; f.body=h1Failure(status); var client=client(f);
            unavailable(()->client.query(request())); var events=new ArrayList<String>();
            unavailable(()->client.stream(request(),(event,data)->events.add(event)));
            assertTrue(events.isEmpty()); assertEquals(2,f.calls.get());
            assertEquals(List.of("Bearer "+bearer),f.headers.get("Authorization"));
            assertFalse(output.getAll().contains(bearer));
            assertFalse(output.getAll().contains(TOKEN)); assertFalse(output.getAll().contains(secret.toString()));
        }
    }
    @Test void liveness200NeverTurnsNotReadyIntoAnAnswer() throws Exception {
        try(var f=new Fixture()) {
            var http=HttpClient.newHttpClient();
            for(String path:List.of("/v1/health","/v1/health?mode=ready&capability=query-v1")) {
                var response=http.send(HttpRequest.newBuilder(URI.create(f.url()+path)).header("Authorization","Bearer "+TOKEN).GET().build(),HttpResponse.BodyHandlers.ofString());
                assertEquals(path.contains("?")?503:200,response.statusCode());
                if(path.contains("?")) assertEquals("NOT_READY",json.readTree(response.body()).path("error").path("code").asText());
                else assertEquals("alive",json.readTree(response.body()).path("status").asText());
            }
            f.status=503; f.body=h1Failure(503); var client=client(f); unavailable(()->client.query(request()));
            var events=new ArrayList<String>(); unavailable(()->client.stream(request(),(event,data)->events.add(event))); assertTrue(events.isEmpty());
            var unconfigured=client(f,Map.of("app.kag-release-id","","app.kag-webapp-snapshot-id",""),null);
            unavailable(()->unconfigured.query(request())); assertEquals(2,f.calls.get());
        }
    }
    @Test void refusedConnectionNeverEmitsStreamEvents() throws Exception {
        try(var f=new Fixture()) {
            var client=client(f); f.server.stop(0); unavailable(()->client.query(request()));
            var events=new ArrayList<String>(); unavailable(()->client.stream(request(),(event,data)->events.add(event))); assertTrue(events.isEmpty());
        }
    }
    @Test void circuitBreakerAndNoUnsafePostRetryRemain() throws Exception {
        try(var f=new Fixture()) { f.status=503; var client=client(f); for(int i=0;i<4;i++) unavailable(()->client.query(request())); assertEquals(3,f.calls.get()); }
        try(var f=new Fixture()) { f.closeBeforeHeaders=true; unavailable(()->client(f).query(request())); assertEquals(1,f.calls.get()); }
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void realReadTimeoutRemains30Seconds(boolean streaming) throws Exception {
        try(var f=new Fixture()) { f.delay=31000; long start=System.nanoTime(); var client=client(f); var events=new ArrayList<String>();
            unavailable(()->{ if(streaming) client.stream(request(),(event,data)->events.add(event)); else client.query(request()); });
            assertTrue(events.isEmpty());
            long seconds=Duration.ofNanos(System.nanoTime()-start).toSeconds(); assertTrue(seconds>=29&&seconds<36); assertEquals(1,f.calls.get()); }
    }
    @Test void sampleQueryTimeoutIsBoundedWithoutChangingDefault() throws Exception {
        try(var f=new Fixture()) {
            var client=client(f);
            assertThrows(IllegalArgumentException.class,()->client.queryTimeout(29));
            assertThrows(IllegalArgumentException.class,()->client.queryTimeout(181));
            client.queryTimeout(180);
            assertNotNull(client.query(request()));
        }
    }
    @Test void reflectedServiceTokenNeverReachesRestOrStreamConsumer() throws Exception {
        try(var f=new Fixture()) {
            f.body=((com.fasterxml.jackson.databind.node.ObjectNode)answer()).put("answer",TOKEN).toString();
            unavailable(()->client(f).query(request()));
        }
        try(var f=new Fixture()) {
            f.delta=TOKEN; var events=new AtomicInteger();
            unavailable(()->client(f).stream(request(),(event,data)->events.incrementAndGet())); assertEquals(0,events.get());
        }
    }
    @Test void strictWireRejectsMalformedUtf8CompressionAndDuplicateValidFields() throws Exception {
        for(String mode:List.of("utf8","gzip","duplicate","surrogate","unknown")) try(var f=new Fixture()) {
            if(mode.equals("utf8")) f.raw=new byte[]{(byte)0xc3,0x28};
            else if(mode.equals("gzip")) f.encoding="gzip";
            else if(mode.equals("duplicate")) f.body="{\"answer\":\"x\","+f.body.substring(1);
            else if(mode.equals("surrogate")) f.body=f.body.replace("Căn cứ nguyên văn 🚦.","\\ud800");
            else f.body="{\"unknown\":true,"+f.body.substring(1);
            unavailable(()->client(f).query(request()));
        }
    }
    @Test void doneOnlyPreservesEveryCitationAndExactRestPayload() throws Exception {
        try(var f=new Fixture()) {
            var expected=(com.fasterxml.jackson.databind.node.ObjectNode)answer();
            var citations=(com.fasterxml.jackson.databind.node.ArrayNode)expected.path("citations");
            var second=(com.fasterxml.jackson.databind.node.ObjectNode)citations.get(0).deepCopy();
            second.put("unit_id","test::2").put("evidence_id","b".repeat(64));
            citations.add(second); f.body=expected.toString();
            f.raw=("event: done\ndata: "+f.body+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            f.media="text/event-stream; charset=utf-8";
            var events=new ArrayList<String>(); var payloads=new ArrayList<JsonNode>();
            client(f).stream(request(),(event,data)->{ events.add(event); payloads.add(data); });
            assertEquals(List.of("done"),events); assertEquals(List.of(expected),payloads);
            f.raw=null; f.media="application/json";
            assertEquals(expected,client(f).query(request()));
        }
    }
    @Test void legacyDeltaDoneRemainsExactAndOrdered() throws Exception {
        try(var f=new Fixture()) {
            var events=new ArrayList<String>(); var payloads=new ArrayList<JsonNode>();
            client(f).stream(request(),(event,data)->{ events.add(event); payloads.add(data); });
            assertEquals(List.of("delta","done"),events);
            assertEquals(json.createObjectNode().put("text",f.delta),payloads.getFirst());
            assertEquals(answer(),payloads.getLast());
        }
    }
    @ParameterizedTest @ValueSource(strings={"missing","truncated-json","no-blank","one-newline","unknown-error","partial-error","duplicate-json","malformed-utf8","empty-citations"})
    void malformedOrIncompleteSseNeverDeliversDone(String mode) throws Exception {
        try(var f=new Fixture()) {
            String done="event: done\ndata: "+f.body;
            String delta="event: delta\ndata: {\"text\":\"partial\"}\n\n";
            f.raw=switch(mode) {
                case "missing" -> delta.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "truncated-json" -> (done.substring(0,done.length()-1)+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "no-blank" -> done.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "one-newline" -> (done+"\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "unknown-error" -> "event: error\ndata: {\"message\":\"unavailable\"}\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "partial-error" -> (delta+"event: error\ndata: {\"message\":").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "duplicate-json" -> ("event: done\ndata: {\"answer\":\"x\","+f.body.substring(1)+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                case "empty-citations" -> "event: done\ndata: {\"answer\":\"x\",\"citations\":[]}\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                default -> new byte[]{(byte)0xc3,0x28};
            };
            var events=new ArrayList<String>(); unavailable(()->client(f).stream(request(),(event,data)->events.add(event)));
            assertFalse(events.contains("done"));
            assertEquals(mode.equals("missing")||mode.equals("partial-error")?List.of("delta"):List.of(),events);
        }
    }
    @Test void streamByteCeilingRejectsWholeOversizedDoneWithoutConsumer() throws Exception {
        for(int size:new int[]{245760,256*1024,256*1024+1}) try(var f=new Fixture()) {
            String frame="event: done\ndata: "+f.body;
            int padding=size-frame.getBytes(java.nio.charset.StandardCharsets.UTF_8).length-2;
            f.raw=(frame+" ".repeat(padding)+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            assertEquals(size,f.raw.length);
            var events=new ArrayList<String>();
            if(size<=256*1024) {
                client(f).stream(request(),(event,data)->{ events.add(event); assertEquals(answer(),data); });
                assertEquals(List.of("done"),events);
            } else {
                unavailable(()->client(f).stream(request(),(event,data)->events.add(event)));
                assertTrue(events.isEmpty());
            }
        }
    }
    @ParameterizedTest @ValueSource(strings={"json-media","text-media","wrong-charset","gzip","missing-release","wrong-snapshot","duplicate-date"})
    void invalidSseMediaOrIdentityFailsBeforeAnyEvent(String mode) throws Exception {
        try(var f=new Fixture()) {
            f.raw=("event: done\ndata: "+f.body+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            switch(mode) {
                case "json-media" -> f.media="application/json; charset=utf-8";
                case "text-media" -> f.media="text/plain";
                case "wrong-charset" -> f.media="text/event-stream; charset=iso-8859-1";
                case "gzip" -> f.encoding="gzip";
                case "missing-release" -> f.omit="X-KAG-Release-ID";
                case "wrong-snapshot" -> f.wrong="X-WebApp-Snapshot-ID";
                default -> f.duplicate="X-KAG-As-Of";
            }
            var events=new ArrayList<String>(); unavailable(()->client(f).stream(request(),(event,data)->events.add(event)));
            assertTrue(events.isEmpty());
        }
    }
    @ParameterizedTest @ValueSource(ints={409,502,503,504})
    void preheaderSseFailuresNeverConsumeFabricatedDone(int status) throws Exception {
        try(var f=new Fixture()) {
            f.status=status; f.raw=("event: done\ndata: "+f.body+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            var events=new ArrayList<String>(); unavailable(()->client(f).stream(request(),(event,data)->events.add(event)));
            assertTrue(events.isEmpty()); assertEquals(1,f.calls.get());
        }
    }
    @ParameterizedTest @ValueSource(strings={"exact","one-over","astral-exact","astral-one-over"})
    void legacyDeltaUtf16LimitRejectsBeforeConsumer(String mode) throws Exception {
        try(var f=new Fixture()) {
            f.delta=switch(mode) {
                case "exact" -> "x".repeat(4000);
                case "one-over" -> "x".repeat(4001);
                case "astral-exact" -> "🚦".repeat(2000);
                default -> "🚦".repeat(2000)+"x";
            };
            var events=new ArrayList<String>();
            if(mode.endsWith("one-over")) {
                unavailable(()->client(f).stream(request(),(event,data)->events.add(event)));
                assertTrue(events.isEmpty());
            } else {
                client(f).stream(request(),(event,data)->events.add(event));
                assertEquals(List.of("delta","done"),events);
            }
        }
    }
}
