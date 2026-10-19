package vn.luatgt.integration;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.core.JsonParser;
import io.github.resilience4j.circuitbreaker.*;
import java.io.*;
import java.net.http.HttpClient;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.function.BiConsumer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;
import vn.luatgt.service.KagSchema;
import vn.luatgt.dto.ChatRetrievalChangeRequest;
import vn.luatgt.dto.LLMCredentialsChangeRequest;
import vn.luatgt.dto.ModelConfigActionRequest;

@Component
public class KagClient {
    private final RestClient client,inspectionClient; private final ObjectMapper json;
    private final JdkClientHttpRequestFactory queryFactory,inspectionFactory;
    private final RestClient servingClient;
    private final KagSchema schema;
    private final String tokenFile,inspectTokenFile,release,snapshot;
    private final Clock clock;
    private RestClient builderClient,builderConfigurationClient;
    @Value("${app.kag-builder-token-file:}") private String builderTokenFile="";
    @Value("${app.kag-credentials-write-token-file:}") private String credentialsWriteTokenFile="";
    @Value("${app.kag-provider-test-token-file:}") private String providerTestTokenFile="";
    @Value("${app.kag-config-apply-token-file:}") private String configApplyTokenFile="";
    private static final ZoneId LEGAL_ZONE=ZoneId.of("Asia/Saigon");
    private static final Set<String> REQUEST_FIELDS=Set.of("user_id","message","context_id","schema_contract");
    private static final Set<String> CITATION_FIELDS=Set.of("doc_id","unit_id","sign_id","evidence_id","field","start","end","quote");
    private final CircuitBreaker breaker=CircuitBreaker.of("kag",CircuitBreakerConfig.custom().minimumNumberOfCalls(3).slidingWindowSize(6).waitDurationInOpenState(Duration.ofSeconds(30)).build());
    public KagClient(@Value("${app.kag-url}") String url,ObjectMapper json,KagSchema schema,
        @Value("${app.kag-token-file:}") String tokenFile,@Value("${app.kag-release-id:}") String release,
        @Value("${app.kag-webapp-snapshot-id:}") String snapshot,ObjectProvider<Clock> clocks,
        @Value("${app.kag-inspect-token-file:}") String inspectTokenFile) {
        var factory=new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build());
        factory.setReadTimeout(Duration.ofSeconds(30));
        this.queryFactory=factory;
        this.client=RestClient.builder().baseUrl(url).requestFactory(factory).build(); this.json=json;
        this.schema=schema; this.tokenFile=tokenFile; this.release=release; this.snapshot=snapshot;
        this.clock=clocks.getIfAvailable(Clock::systemDefaultZone);
        this.inspectTokenFile=inspectTokenFile;
        var inspectionFactory=new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build());
        inspectionFactory.setReadTimeout(Duration.ofSeconds(2));
        this.inspectionFactory=inspectionFactory;
        this.inspectionClient=RestClient.builder().baseUrl(url).requestFactory(inspectionFactory).build();
        var servingFactory=new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build());
        servingFactory.setReadTimeout(Duration.ofSeconds(150));
        this.servingClient=RestClient.builder().baseUrl(url).requestFactory(servingFactory).build();
    }
    @Value("${app.kag-query-timeout-seconds:30}")
    public void queryTimeout(int seconds) {
        if(seconds<30||seconds>180) throw new IllegalArgumentException("Bounded KAG query timeout required");
        queryFactory.setReadTimeout(Duration.ofSeconds(seconds));
    }
    @Value("${app.kag-inspection-timeout-seconds:2}")
    public void inspectionTimeout(int seconds) {
        if(seconds<2||seconds>25) throw new IllegalArgumentException("Bounded KAG inspection timeout required");
        inspectionFactory.setReadTimeout(Duration.ofSeconds(seconds));
    }
    @Value("${app.kag-builder-url:}")
    public void builderEndpoint(String url) {
        if(url.isBlank()) {builderClient=builderConfigurationClient=null;return;}
        var uri=java.net.URI.create(url);
        if(!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!Set.of("","/").contains(uri.getPath()))
            throw new IllegalArgumentException("Private Builder endpoint required");
        var http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
        var factory=new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(Duration.ofSeconds(3));
        builderClient=RestClient.builder().baseUrl(url).requestFactory(factory).build();
        var saveFactory=new JdkClientHttpRequestFactory(http);
        saveFactory.setReadTimeout(Duration.ofSeconds(60));
        builderConfigurationClient=builderClient.mutate().requestFactory(saveFactory).build();
    }
    public JsonNode builderStatus() {return builderRequest(null,null);}
    public JsonNode builderInputs() {return builderRequest("inputs",null);}
    public JsonNode builderDataset(String group,int offset,int limit) {
        if(!Set.of("documents","units","signs","penalties","relations","xrefs").contains(group)||offset<0||limit<1||limit>50)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Loại nguồn hoặc trang không hợp lệ");
        return builderRequest("dataset/"+group+"/"+offset+"/"+limit,null);
    }
    public JsonNode checkBuilderInputs() {return builderRequest("check-inputs",null);}
    public JsonNode builderConfiguration() {return builderRequest("configuration",null);}
    public JsonNode builderProjects() {return builderRequest("projects",null);}
    public JsonNode graphProject(int projectId) {
        if(projectId<1)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"ID project không hợp lệ");
        return builderRequest("graph/"+projectId,null);
    }
    public JsonNode builderSources(int projectId,String runId) {
        if(projectId<1||runId==null||!runId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Chọn project và phiên đã xác minh");
        return builderRequest("sources/"+projectId+"/"+runId,null);
    }
    public JsonNode serving(String action,JsonNode change,JsonNode publication) {
        try {
            boolean read=action==null;
            if(!read&&(!Set.of("preview","activate").contains(action)||
                !fields(change).equals(action.equals("activate")?Set.of("project_id","run_id","preview_id"):Set.of("project_id","run_id"))||
                !bounded(change.path("project_id"),1,Integer.MAX_VALUE)||!change.path("run_id").asText().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")||
                action.equals("activate")&&!change.path("preview_id").asText().matches("[0-9a-f]{64}")))
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Chọn project, phiên đã xác minh và xem trước lại trước khi kích hoạt");
            String token=read?inspectionToken():readToken(configApplyTokenFile);
            RestClient.RequestHeadersSpec<?> request;
            if(read)request=servingClient.get().uri("/v1/serving");
            else {
                request=servingClient.post().uri("/v1/serving/"+action).contentType(MediaType.APPLICATION_JSON).body(change);
            }
            String session=openSpgSession();if(session!=null)request.header("X-OpenSPG-Session",session);
            return request.header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                var body=inspectionBody(res,token);
                if(res.getStatusCode().value()!=200) {
                    String code=errorCode(body);
                    String reason=switch(code) {
                        case "CONFIG_CONFLICT" -> "Bản xem trước đã cũ. Tải lại và xem trước lần nữa";
                        case "CONFIG_BUSY" -> "Dịch vụ đang xử lý yêu cầu khác. Chờ rồi tải lại trạng thái";
                        case "SCOPE_DENIED" -> "Đăng nhập lại OpenSPG và kiểm quyền sở hữu project";
                        case "RELEASE_MISMATCH" -> "Model Embedding hoặc số chiều không khớp phiên dựng. Chọn lại và kiểm tra model";
                        case "SOURCE_VALIDATION_FAILED" -> "Nguồn graph chưa đầy đủ hoặc khác bản đã xác minh. Kiểm văn bản nguồn và phạm vi dựng trước khi xuất bản";
                        default -> "Chưa thể dùng đồ thị. Kiểm phiên đã xác minh, cấu trúc/chỉ mục và model đã kiểm tra ("+code+")";
                    };
                    throw new ResponseStatusException(HttpStatus.CONFLICT,reason);
                }
                if(read) {
                    if(!body.path("contract_version").asText().equals("builder-serving-v1")||!body.path("runs").isArray()||
                        !body.path("busy").isBoolean()||!body.path("runtime_ready").isBoolean()||!body.path("chat_blockers").isArray())throw new IOException();
                } else if(!body.path("preview_id").asText().matches("[0-9a-f]{64}")||!body.path("chat_blockers").isArray()||
                    !body.path("project_id").equals(change.path("project_id"))||action.equals("activate")&&!body.path("status").asText().equals("ACTIVE"))throw new IOException();
                return body;
            });
        } catch(ResponseStatusException e) {throw e;}
        catch(Exception e) {throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Chưa xác nhận được trạng thái đồ thị phục vụ; tải lại trước khi thao tác tiếp");}
    }
    public JsonNode checkBuilderReadiness() {return builderRequest("preflight",null);}
    public JsonNode builderStructure(String action,JsonNode change) {
        if(action==null)return builderRequest("structure",null);
        if(!Set.of("preview","apply").contains(action)||
            !fields(change).equals(action.equals("apply")?Set.of("project_id","revision","preview_id"):Set.of("project_id","revision"))||
            !bounded(change.path("project_id"),1,Integer.MAX_VALUE)||!bounded(change.path("revision"),0,Integer.MAX_VALUE)||
            action.equals("apply")&&!change.path("preview_id").asText().matches("[0-9a-f]{64}"))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Yêu cầu chuẩn bị cấu trúc không hợp lệ");
        return builderRequest("structure-"+action,change);
    }
    public JsonNode saveBuilderConfiguration(JsonNode change) {
        var allowed=Set.of("revision","embedding_revision","batch_size","request_limit","node_limit","project_id","selection_preview_id");
        if(!fields(change).containsAll(Set.of("revision","embedding_revision","batch_size","request_limit"))||!allowed.containsAll(fields(change))||
            !bounded(change.path("revision"),0,Integer.MAX_VALUE-1)||!bounded(change.path("embedding_revision"),1,Integer.MAX_VALUE)||
            !bounded(change.path("batch_size"),1,4096)||!change.path("request_limit").isNull()&&!bounded(change.path("request_limit"),1,1000000)||
            change.has("node_limit")&&!change.path("node_limit").isNull()&&!bounded(change.path("node_limit"),3,128)||
            change.has("selection_preview_id")&&!change.path("selection_preview_id").asText().matches("[0-9a-f]{64}")||
            change.has("project_id")&&!bounded(change.path("project_id"),1,Integer.MAX_VALUE))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Cấu hình Builder không hợp lệ");
        return builderRequest("save-configuration",change);
    }
    public JsonNode previewBuilderSelection(JsonNode change) {
        if(!fields(change).equals(Set.of("revision","mode","value"))||!bounded(change.path("revision"),0,Integer.MAX_VALUE))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Phạm vi không hợp lệ");
        validateSelectionRequest(change);
        return builderRequest("selection",change);
    }
    private void validateSelectionRequest(JsonNode request) {
        String mode=request.path("mode").asText();var value=request.path("value");
        if(!Set.of("ALL","COUNT","PERCENT").contains(mode)||
            (mode.equals("ALL")?!value.isNull():!bounded(value,mode.equals("COUNT")?3:1,mode.equals("COUNT")?Integer.MAX_VALUE:100)))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Chọn toàn bộ, số lượng nguyên hoặc tỷ lệ 1–100%");
    }
    public JsonNode builderClear(String action,JsonNode change) {
        if(action==null)return builderRequest("clear",null);
        if(!Set.of("preview","apply").contains(action)||!fields(change).equals(action.equals("preview")?Set.of("revision"):Set.of("revision","preview_id","database"))||
            !bounded(change.path("revision"),1,Integer.MAX_VALUE)||action.equals("apply")&&
                (!change.path("preview_id").asText().matches("[0-9a-f]{64}")||!change.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}")))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Yêu cầu xóa dữ liệu không hợp lệ");
        return builderRequest("clear-"+action,change);
    }
    public JsonNode builderAction(String action,String runId) {
        return builderAction(action,runId,null);
    }
    public JsonNode builderAction(String action,String runId,String revision) {
        if(!Set.of("build","stop","resume","abandon").contains(action)||runId==null||!runId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Thao tác Builder không hợp lệ");
        if(revision!=null&&!revision.matches("\"[1-9][0-9]{0,9}\""))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Revision Builder không hợp lệ");
        return builderRequest(action,Map.of("run_id",runId),revision);
    }
    private JsonNode builderRequest(String action,Object payload) {
        return builderRequest(action,payload,null);
    }
    private JsonNode builderRequest(String action,Object payload,String revision) {
        try {
            if(builderClient==null||builderTokenFile.isBlank()||!Path.of(builderTokenFile).isAbsolute())throw new IOException();
            String token=readToken(builderTokenFile);
            for(String file:List.of(tokenFile,inspectTokenFile)) {
                String other=null;try{other=readToken(file);}catch(IOException ignored){}
                if(token.equals(other))throw new IOException();
            }
            boolean graph=action!=null&&action.matches("graph/[1-9][0-9]{0,9}");
            boolean sources=action!=null&&action.startsWith("sources/");
            boolean dataset=action!=null&&action.startsWith("dataset/");
            boolean read=graph||sources||dataset||action==null||Set.of("inputs","configuration","projects","structure","clear").contains(action);
            boolean structure=action!=null&&action.startsWith("structure");
            boolean clear=action!=null&&action.startsWith("clear");
            boolean inputs="inputs".equals(action)||"check-inputs".equals(action);
            boolean configuration=Set.of("configuration","save-configuration","preflight").contains(action==null?"":action);
            String path=action==null?"status":inputs?"inputs":action.equals("save-configuration")?"configuration":structure||clear?action.replace('-', '/'):action;
            var transport=graph||sources||structure||clear||Set.of("save-configuration","projects","selection","abandon").contains(action==null?"":action)?builderConfigurationClient:builderClient;
            RestClient.RequestHeadersSpec<?> request=read?transport.get().uri("/v1/builder/"+path):
                transport.post().uri("/v1/builder/"+path).contentType(MediaType.APPLICATION_JSON).body(payload==null?Map.of():payload);
            if(revision!=null)request.header(HttpHeaders.IF_MATCH,revision);
            if(graph||sources||structure||clear||Set.of("projects","save-configuration","preflight","build","resume","abandon").contains(action==null?"":action)) {
                String session=openSpgSession();
                if(session!=null)request.header("X-OpenSPG-Session",session);
            }
            return request.header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                int code=res.getStatusCode().value();
                if((graph||sources)&&(code==403||code==404))throw new ResponseStatusException(code==403?HttpStatus.FORBIDDEN:HttpStatus.NOT_FOUND,
                    code==403?"Đăng nhập lại OpenSPG và kiểm quyền sở hữu project":"Project không còn thuộc danh sách được phép xem; hãy tải lại");
                if(code==409) {
                    if("selection".equals(action)&&inspectionBody(res,token).path("detail").asText().equals("BUILDER_SELECTION_INVALID"))
                        throw new ResponseStatusException(HttpStatus.CONFLICT,"Phạm vi quá nhỏ để giữ đủ loại, quan hệ và nguồn liên quan. Tăng giới hạn rồi xem trước lại");
                    throw new ResponseStatusException(HttpStatus.CONFLICT,"Builder đang bận hoặc thao tác chưa an toàn; hãy tải lại trạng thái");
                }
                if(code==422)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Yêu cầu Builder không hợp lệ");
                if(code!=(read?200:202))throw new IOException();
                JsonNode body;
                try { body=inspectionBody(res,token,sources?32*1024*1024:245760); }
                catch(IOException e) { if(sources&&"Response too large".equals(e.getMessage()))throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"Danh sách nguồn vượt giới hạn 32 MiB; chưa thể xem hoặc nhập qua màn này");throw e; }
                if(dataset)validateDataset(body,action);else if(sources)validateBuilderSources(body,action);else if(graph)validateGraphProject(body,Integer.parseInt(action.substring(6)));else if(structure)validateBuilderStructure(body);else if(clear)validateBuilderClear(body);else if("selection".equals(action))validateBuilderSelection(body);else if("projects".equals(action))validateBuilderProjects(body);else if(inputs)validateBuilderInputs(body);else if(configuration)validateBuilderConfiguration(body);else validateBuilder(body);
                if(!read&&!inputs&&!configuration&&!structure&&!clear&&!"selection".equals(action)&&!body.path("run_id").asText().equals(((Map<?,?>)payload).get("run_id")))throw new IOException();
                return body;
            });
        } catch(ResponseStatusException e) {throw e;}
        catch(Exception e) {throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Builder chưa khả dụng; kiểm tra cấu hình Worker và quyền điều khiển");}
    }
    private void validateBuilderSources(JsonNode body,String action) throws IOException {
        var target=body.path("target");var parts=action.split("/");
        if(!fields(body).equals(Set.of("contract_version","target","run_id","partial","documents","units","release"))||
            !body.path("contract_version").asText().equals("builder-sources-v1")||!body.path("run_id").asText().equals(parts[2])||
            !body.path("partial").isBoolean()||!fields(target).equals(Set.of("project_id","project_name","database","namespace"))||
            !bounded(target.path("project_id"),Integer.parseInt(parts[1]),Integer.parseInt(parts[1]))||!text(target.path("project_name"),255,true)||
            !target.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}")||!target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}"))throw new IOException();
        for(String group:List.of("documents","units")) {
            var rows=body.path(group);if(!rows.isArray()||rows.size()>1_000_000)throw new IOException();
            var seen=new HashSet<String>();
            for(var row:rows)if(!row.isObject()||!text(row.path(group.equals("documents")?"doc_id":"unit_id"),group.equals("documents")?250:500,true)||
                !seen.add(row.path(group.equals("documents")?"doc_id":"unit_id").asText())||!group.equals("documents")&&(!text(row.path("doc_id"),250,true)||!row.path("text").isTextual()))throw new IOException();
        }
        var release=body.path("release");
        if(!release.isNull()&&(!fields(release).equals(Set.of("release_id","documents","units"))||!text(release.path("release_id"),128,true)||
            !release.path("documents").isArray()||!release.path("units").isArray()))throw new IOException();
    }
    private void validateDataset(JsonNode body,String action) throws IOException {
        var parts=action.split("/");int offset=Integer.parseInt(parts[2]),limit=Integer.parseInt(parts[3]);
        if(!fields(body).equals(Set.of("contract_version","dataset","group","source","offset","limit","total","items"))||
            !body.path("contract_version").asText().equals("builder-dataset-v1")||!text(body.path("dataset"),512,true)||
            !body.path("group").asText().equals(parts[1])||!text(body.path("source"),512,true)||
            body.path("offset").asInt(-1)!=offset||body.path("limit").asInt(-1)!=limit||!bounded(body.path("total"),0,Integer.MAX_VALUE)||
            !body.path("items").isArray()||body.path("items").size()!=Math.min(limit,Math.max(0,body.path("total").asInt()-offset)))throw new IOException("Invalid dataset page");
        for(var item:body.path("items"))if(!item.isObject())throw new IOException("Invalid source record");
    }
    private void validateGraphProject(JsonNode body,int projectId) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","target","database_id","measured_from","measured_at","counts","labels","relations","indexes","vector_count_kind"))||
            !body.path("contract_version").asText().equals("graph-project-v1")||!body.path("vector_count_kind").asText().equals("NONEMPTY")||
            !text(body.path("database_id"),255,true))throw new IOException();
        var target=body.path("target");
        if(!fields(target).equals(Set.of("project_id","project_name","namespace","database"))||!bounded(target.path("project_id"),projectId,projectId)||
            !text(target.path("project_name"),255,true)||!target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}")||
            !target.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}"))throw new IOException();
        for(String field:List.of("measured_from","measured_at")) {
            if(!text(body.path(field),64,true))throw new IOException();
            java.time.OffsetDateTime.parse(body.path(field).asText());
        }
        if(!fields(body.path("counts")).equals(Set.of("nodes","edges","vectors")))throw new IOException();
        for(String field:List.of("nodes","edges","vectors"))if(!bounded(body.path("counts").path(field),0,Integer.MAX_VALUE))throw new IOException();
        for(String group:List.of("labels","relations")) {
            if(!body.path(group).isArray()||body.path(group).size()>2048)throw new IOException();
            var names=new HashSet<String>();
            for(var row:body.path(group))if(!fields(row).equals(Set.of("name","count"))||!text(row.path("name"),512,true)||
                !names.add(row.path("name").asText())||!bounded(row.path("count"),0,Integer.MAX_VALUE))throw new IOException();
        }
        if(!body.path("indexes").isArray()||body.path("indexes").size()>2048)throw new IOException();
        for(var row:body.path("indexes")) {
            if(!fields(row).equals(Set.of("name","state","type","labels","properties","dimension"))||!text(row.path("name"),512,true)||
                !text(row.path("state"),32,true)||!text(row.path("type"),32,true)||!row.path("dimension").isNull()&&!bounded(row.path("dimension"),1,65536))throw new IOException();
            for(String field:List.of("labels","properties")) {
                if(!row.path(field).isArray()||row.path(field).size()>512)throw new IOException();
                for(var item:row.path(field))if(!text(item,512,true))throw new IOException();
            }
        }
    }
    private void validateBuilderStructure(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","state","revision","preview_id","checked_at","can_apply","report","code"))||
            !body.path("contract_version").asText().equals("builder-structure-v1")||
            !Set.of("NOT_RUN","PREVIEW","APPLYING","COMPLETE","PARTIAL","INTERRUPTED","BLOCKED").contains(body.path("state").asText())||
            !bounded(body.path("revision"),0,Integer.MAX_VALUE)||!body.path("can_apply").isBoolean()||
            !body.path("preview_id").isNull()&&!body.path("preview_id").asText().matches("[0-9a-f]{64}")||
            !body.path("checked_at").isNull()&&!body.path("checked_at").isTextual()||
            !body.path("code").isNull()&&!body.path("code").asText().matches("[A-Z_]{1,32}"))throw new IOException();
        var report=body.path("report");
        if(!report.isNull()) {
            var reportFields=new HashSet<>(Set.of("target","database_id","dimension","counts","changes","indexes","conflicts","code","native_rebuild"));
            boolean extended=report.has("build_ready");
            if(extended)reportFields.addAll(Set.of("build_ready","default_types","index_changes"));
            if(!fields(report).equals(reportFields)||
                !report.path("database_id").isTextual()||report.path("database_id").asText().isBlank()||report.path("database_id").asText().length()>255||
                !bounded(report.path("dimension"),1,65536)||!fields(report.path("counts")).equals(Set.of("nodes","edges"))||
                !bounded(report.path("counts").path("nodes"),0,Integer.MAX_VALUE)||!bounded(report.path("counts").path("edges"),0,Integer.MAX_VALUE))throw new IOException();
            var target=report.path("target");
            if(!fields(target).equals(Set.of("project_id","project_name","namespace","database"))||!bounded(target.path("project_id"),1,Integer.MAX_VALUE)||
                !target.path("project_name").isTextual()||target.path("project_name").asText().length()>255||
                !target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}")||!target.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}"))throw new IOException();
            if(!report.path("changes").isArray()||report.path("changes").size()>512||!report.path("indexes").isArray()||report.path("indexes").size()!=4||
                !report.path("code").isNull()&&!report.path("code").asText().matches("[A-Z_]{1,32}"))throw new IOException();
            for(var row:report.path("changes"))if(!fields(row).equals(Set.of("kind","action","name"))||
                !Set.of("type","property","relation").contains(row.path("kind").asText())||!Set.of("ADD","UPDATE","REMOVE","KEEP").contains(row.path("action").asText())||
                !row.path("name").asText().matches("[A-Za-z][A-Za-z0-9_.]{0,255}"))throw new IOException();
            for(var row:report.path("indexes"))if(!fields(row).equals(Set.of("label","property","action"))||
                !row.path("label").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}\\.(LegalDocument|LegalUnit|TrafficSign)")||
                !Set.of("_title_vector","_text_vector","_ten_vector","_mo_ta_vector").contains(row.path("property").asText())||
                !Set.of("ADD","KEEP","REBUILD","BLOCKED").contains(row.path("action").asText()))throw new IOException();
            for(String name:List.of("conflicts","native_rebuild")) {
                if(!report.path(name).isArray()||report.path(name).size()>2048)throw new IOException();
                for(var row:report.path(name))if(!row.isTextual()||row.asText().length()>512)throw new IOException();
            }
            if(extended) {
                if(!report.path("build_ready").isBoolean()||!report.path("default_types").isArray()||report.path("default_types").size()>18||
                    !report.path("index_changes").isArray()||report.path("index_changes").size()>2048)throw new IOException();
                for(var row:report.path("default_types"))if(!row.isTextual()||!row.asText().matches("[A-Za-z][A-Za-z0-9_.]{0,255}"))throw new IOException();
                for(var row:report.path("index_changes")) {
                    if(!fields(row).equals(Set.of("name","type","labels","properties","action"))||!row.path("name").isTextual()||row.path("name").asText().isBlank()||row.path("name").asText().length()>512||
                        !row.path("type").asText().matches("[A-Z_]{1,32}")||!Set.of("ADD","KEEP","REMOVE","REBUILD","BLOCKED").contains(row.path("action").asText()))throw new IOException();
                    for(String key:List.of("labels","properties")) {
                        if(!row.path(key).isArray()||row.path(key).size()>512)throw new IOException();
                        for(var item:row.path(key))if(!item.isTextual()||item.asText().length()>512)throw new IOException();
                    }
                }
            }
        }
        if(body.path("can_apply").asBoolean()&&(!body.path("state").asText().equals("PREVIEW")||report.isNull()||!report.path("code").isNull()))throw new IOException();
        if(body.path("state").asText().equals("COMPLETE")&&(report.isNull()||!report.path("code").isNull()||
            java.util.stream.StreamSupport.stream(report.path("changes").spliterator(),false).anyMatch(row->!row.path("action").asText().equals("KEEP"))||
            !report.path("default_types").isMissingNode()&&!report.path("default_types").isEmpty()||
            java.util.stream.StreamSupport.stream(report.path("index_changes").spliterator(),false).anyMatch(row->!row.path("action").asText().equals("KEEP"))||
            java.util.stream.StreamSupport.stream(report.path("indexes").spliterator(),false).anyMatch(row->!row.path("action").asText().equals("KEEP"))))throw new IOException();
    }
    private void validateBuilderClear(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","state","revision","preview_id","report","deleted","checked_at","code"))||
            !body.path("contract_version").asText().equals("builder-clear-v1")||!bounded(body.path("revision"),0,Integer.MAX_VALUE)||
            !Set.of("NOT_RUN","PREVIEW","APPLYING","COMPLETE","PARTIAL","INTERRUPTED","BLOCKED").contains(body.path("state").asText())||
            !body.path("preview_id").isNull()&&!body.path("preview_id").asText().matches("[0-9a-f]{64}")||
            !body.path("code").isNull()&&!body.path("code").asText().matches("[A-Z_]{1,32}")||
            !body.path("checked_at").isNull()&&!body.path("checked_at").isTextual())throw new IOException();
        var deleted=body.path("deleted");
        if(!fields(deleted).equals(Set.of("nodes","edges"))||!bounded(deleted.path("nodes"),0,Integer.MAX_VALUE)||!bounded(deleted.path("edges"),0,Integer.MAX_VALUE))throw new IOException();
        var report=body.path("report");
        if(report.isNull()) {
            if(Set.of("PREVIEW","APPLYING","COMPLETE","PARTIAL").contains(body.path("state").asText()))throw new IOException();
            return;
        }
        var target=report.path("target");var counts=report.path("counts");
        if(!fields(report).equals(Set.of("target","database_id","counts","batch_size"))||!bounded(report.path("batch_size"),500,500)||
            !report.path("database_id").asText().matches("[A-Za-z0-9._:-]{1,128}")||!fields(target).equals(Set.of("project_id","project_name","namespace","database"))||
            !bounded(target.path("project_id"),1,Integer.MAX_VALUE)||!target.path("project_name").isTextual()||target.path("project_name").asText().isBlank()||target.path("project_name").asText().length()>255||
            !target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}")||!target.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}")||
            !fields(counts).equals(Set.of("nodes","edges"))||!bounded(counts.path("nodes"),0,Integer.MAX_VALUE)||!bounded(counts.path("edges"),0,Integer.MAX_VALUE)||
            body.path("preview_id").isNull())throw new IOException();
    }
    private String openSpgSession() throws IOException {
        var context=org.springframework.web.context.request.RequestContextHolder.getRequestAttributes();
        if(!(context instanceof org.springframework.web.context.request.ServletRequestAttributes servlet))return null;
        var cookies=servlet.getRequest().getCookies();String session=null;
        if(cookies!=null)for(var cookie:cookies)if(cookie.getName().equals("OPEN_SPG_TOKEN")) {
            if(session!=null||!cookie.getValue().matches("[A-Za-z0-9._~+/=%:-]{1,8192}"))throw new IOException();
            session=cookie.getValue();
        }
        return session;
    }
    private void validateBuilderProjects(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","state","projects"))||!body.path("contract_version").asText().equals("builder-projects-v1")||
            !Set.of("AVAILABLE","EMPTY","FORBIDDEN","NOT_CONFIGURED","UNAVAILABLE").contains(body.path("state").asText())||
            !body.path("projects").isArray()||body.path("projects").size()>10000)throw new IOException();
        var ids=new HashSet<Integer>();
        for(var row:body.path("projects")) {
            if(!fields(row).equals(Set.of("project_id","project_name","namespace","database","state"))||!bounded(row.path("project_id"),1,Integer.MAX_VALUE)||
                !ids.add(row.path("project_id").asInt())||!row.path("project_name").isTextual()||row.path("project_name").asText().isBlank()||row.path("project_name").asText().length()>255||
                !row.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}")||
                !row.path("database").isNull()&&!row.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}")||
                !Set.of("AVAILABLE","CONNECTION_NOT_CONFIGURED","SERVING_PROTECTED").contains(row.path("state").asText())||
                row.path("state").asText().equals("AVAILABLE")&&row.path("database").isNull())throw new IOException();
        }
        if(body.path("state").asText().equals("AVAILABLE")==body.path("projects").isEmpty())throw new IOException();
        if(!body.path("state").asText().equals("AVAILABLE")&&!body.path("projects").isEmpty())throw new IOException();
    }
    private void validateBuilderConfiguration(JsonNode body) throws IOException {
        boolean extended=body.path("contract_version").asText().equals("builder-configuration-v4");
        boolean projects=extended||body.path("contract_version").asText().equals("builder-configuration-v3");
        boolean selected=projects||body.path("contract_version").asText().equals("builder-configuration-v2");
        var expected=new HashSet<>(Set.of("contract_version","revision","saved","error_code","target","embedding","batch_size","request_limit","readiness"));
        if(selected)expected.add("selection");
        if(projects)expected.add("links");
        if(!fields(body).equals(expected)||
            !Set.of("builder-configuration-v1","builder-configuration-v2","builder-configuration-v3","builder-configuration-v4").contains(body.path("contract_version").asText())||!bounded(body.path("revision"),0,Integer.MAX_VALUE)||
            !body.path("saved").isBoolean()||body.path("saved").asBoolean()!=(body.path("revision").asInt()>0)||
            !bounded(body.path("batch_size"),1,4096)||!body.path("request_limit").isNull()&&!bounded(body.path("request_limit"),1,1000000)||
            !body.path("error_code").isNull()&&!body.path("error_code").asText().equals("CONFIG"))throw new IOException();
        if(selected) {
            var selection=body.path("selection");
            if(!fields(selection).equals(extended?Set.of("node_limit","nodes","edges","request","summary"):Set.of("node_limit","nodes","edges"))||
                !selection.path("node_limit").isNull()&&!bounded(selection.path("node_limit"),3,extended?Integer.MAX_VALUE:128)||
                !selection.path("nodes").isNull()&&!bounded(selection.path("nodes"),0,Integer.MAX_VALUE)||
                !selection.path("edges").isNull()&&!bounded(selection.path("edges"),0,Integer.MAX_VALUE)||
                !selection.path("node_limit").isNull()&&(!bounded(selection.path("nodes"),1,selection.path("node_limit").asInt())||!bounded(selection.path("edges"),1,extended?Integer.MAX_VALUE:256)))throw new IOException();
            if(extended) {
                if(!fields(selection.path("request")).equals(Set.of("mode","value")))throw new IOException();
                validateSelectionRequest(selection.path("request"));
                if(!selection.path("summary").isNull()) {
                    validateSelectionSummary(selection.path("summary"));
                    for(String key:List.of("nodes","edges"))if(!selection.path(key).equals(selection.path("summary").path(key)))throw new IOException();
                }
            }
        }
        var target=body.path("target");
        if(!target.isNull()&&(!fields(target).equals(Set.of("project_id","project_name","database","namespace"))||
            !bounded(target.path("project_id"),1,Integer.MAX_VALUE)||!target.path("project_name").isTextual()||target.path("project_name").asText().isBlank()||target.path("project_name").asText().length()>255||
            !target.path("database").asText().matches("[a-z][a-z0-9.-]{0,62}")||!target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}")))throw new IOException();
        if(projects&&!body.path("links").isNull()) {
            var links=body.path("links");
            if(!fields(links).equals(Set.of("openspg","neo4j","bolt")))throw new IOException();
            for(String name:List.of("openspg","neo4j","bolt")) {
                var uri=java.net.URI.create(links.path(name).asText());
                if(!(name.equals("bolt")?Set.of("bolt","neo4j","bolt+s","neo4j+s"):Set.of("http","https")).contains(uri.getScheme())||
                    uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null)throw new IOException();
            }
        }
        var embedding=body.path("embedding");
        if(!embedding.isNull()) {
            if(!fields(embedding).equals(Set.of("provider","base_url","model","revision","key_configured","tested","dimension"))||
                !embedding.path("provider").asText().equals("openai-compatible")||!bounded(embedding.path("revision"),1,Integer.MAX_VALUE)||
                !embedding.path("key_configured").isBoolean()||!embedding.path("tested").isBoolean()||
                !embedding.path("model").asText().matches("[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}")||
                !embedding.path("dimension").isNull()&&!bounded(embedding.path("dimension"),1,65536))throw new IOException();
            var uri=java.net.URI.create(embedding.path("base_url").asText());
            if(!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null)throw new IOException();
        }
        var ready=body.path("readiness");String state=ready.path("state").asText();
        if(!fields(ready).equals(Set.of("state","checks","checked_at"))||!Set.of("NOT_RUN","CHECKING","READY","BLOCKED").contains(state)||
            !ready.path("checks").isArray()||ready.path("checks").size()>4||!ready.path("checked_at").isNull()&&!ready.path("checked_at").isTextual())throw new IOException();
        var names=new HashSet<String>();
        for(var row:ready.path("checks")) {
            if(!fields(row).equals(row.has("owner")?Set.of("name","state","code","owner"):Set.of("name","state","code"))||!Set.of("source","embedding","target","lock").contains(row.path("name").asText())||!names.add(row.path("name").asText())||
                !Set.of("READY","BLOCKED","NOT_CHECKED").contains(row.path("state").asText())||
                row.path("state").asText().equals("NOT_CHECKED")&&!Set.of("WAIT_SOURCE","WAIT_EMBEDDING","WAIT_TARGET").contains(row.path("code").asText())||
                (row.path("state").asText().equals("READY")?!row.path("code").isNull():!row.path("code").asText().matches("[A-Z_]{1,32}")))throw new IOException();
            if(row.has("owner")) {
                var owner=row.path("owner");
                if(!row.path("name").asText().equals("lock")||!row.path("state").asText().equals("BLOCKED")||!row.path("code").asText().equals("LOCK")||
                    !fields(owner).equals(Set.of("run_id","project_id"))||!owner.path("run_id").isTextual()||!owner.path("run_id").asText().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")||
                    !bounded(owner.path("project_id"),1,Integer.MAX_VALUE))throw new IOException();
            }
        }
        if(state.equals("READY")&&(names.size()!=4||!body.path("saved").asBoolean()||target.isNull()||embedding.isNull()||
            !embedding.path("tested").asBoolean()||!bounded(embedding.path("dimension"),1,65536)||
            java.util.stream.StreamSupport.stream(ready.path("checks").spliterator(),false).anyMatch(row->!row.path("state").asText().equals("READY"))))throw new IOException();
    }
    private void validateBuilderInputs(JsonNode body) throws IOException {
        String configuration=body.path("configuration").asText();
        if(!fields(body).equals(Set.of("contract_version","configuration","error_code","scope","target","inputs","preflight","source_validation"))||
            !Set.of("builder-inputs-v1","builder-inputs-v2","builder-inputs-v3").contains(body.path("contract_version").asText())||!Set.of("NOT_CONFIGURED","INVALID","CONFIGURED").contains(configuration)||
            !body.path("preflight").asText().equals("NOT_RUN"))throw new IOException();
        boolean configured=configuration.equals("CONFIGURED");
        if(configuration.equals("INVALID")?!body.path("error_code").asText().equals("CONFIG"):!body.path("error_code").isNull())throw new IOException();
        var target=body.path("target");
        if(configured) {
            if(!Set.of("FRESH_SAMPLE","PRODUCTION").contains(body.path("scope").asText())||!fields(target).equals(Set.of("project_id","database","namespace"))||
                !bounded(target.path("project_id"),1,Integer.MAX_VALUE)||!target.path("database").asText().matches(body.path("scope").asText().equals("PRODUCTION")?"[a-z][a-z0-9.-]{0,62}":"(?:neo4j|vietroadtraffic|freshsample[a-z0-9]{8,40})")||
                !target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}"))throw new IOException();
        } else if(!target.isNull()||!body.path("scope").isNull())throw new IOException();
        var inputs=body.path("inputs");var names=new HashSet<String>();
        var expected=Set.of("c3_manifest","sample_manifest","vector_artifact","provenance","chunk_manifest","source_checkpoint","selection");
        if(!inputs.isArray()||(configured?inputs.isEmpty()||inputs.size()>expected.size()||body.path("scope").asText().equals("FRESH_SAMPLE")&&inputs.size()!=6:!inputs.isEmpty()))throw new IOException();
        for(var input:inputs) {
            String name=input.path("name").asText();
            if(!fields(input).equals(Set.of("name","sha256","state"))||!expected.contains(name)||!names.add(name)||
                !input.path("sha256").asText().matches("[0-9a-f]{64}")||!Set.of("NOT_CHECKED","MATCHED","MISSING","INVALID","UNAVAILABLE").contains(input.path("state").asText()))throw new IOException();
        }
        if(configured&&!names.contains("c3_manifest"))throw new IOException();
        var source=body.path("source_validation");String state=source.path("state").asText();
        boolean extended=body.path("contract_version").asText().equals("builder-inputs-v3");
        if(!fields(source).equals(extended?Set.of("state","error_code","plan_sha256","nodes","edges","summary"):Set.of("state","error_code","plan_sha256","nodes","edges"))||
            !Set.of("NOT_RUN","CHECKING","VALID","INVALID","UNAVAILABLE").contains(state))throw new IOException();
        String error=switch(state){case "INVALID"->"INTEGRITY";case "UNAVAILABLE"->"RUNTIME";default->null;};
        if(error==null?!source.path("error_code").isNull():!source.path("error_code").asText().equals(error))throw new IOException();
        if(state.equals("VALID")?body.path("contract_version").asText().equals("builder-inputs-v1")&&!configured||!source.path("plan_sha256").isTextual()||!source.path("plan_sha256").asText().matches("[0-9a-f]{64}")||
            !bounded(source.path("nodes"),0,Integer.MAX_VALUE)||!bounded(source.path("edges"),0,Integer.MAX_VALUE):
            !source.path("plan_sha256").isNull()||!source.path("nodes").isNull()||!source.path("edges").isNull())throw new IOException();
        if(extended) {
            if(state.equals("VALID")) {
                validateSelectionSummary(source.path("summary"));
                for(String key:List.of("nodes","edges"))if(!source.path(key).equals(source.path("summary").path(key)))throw new IOException();
            } else if(!source.path("summary").isNull())throw new IOException();
        }
    }
    private void validateSelectionSummary(JsonNode summary) throws IOException {
        if(!fields(summary).equals(Set.of("nodes","edges","node_counts","edge_counts","excluded_edges"))||
            !bounded(summary.path("nodes"),0,Integer.MAX_VALUE)||!bounded(summary.path("edges"),0,Integer.MAX_VALUE)||
            !bounded(summary.path("excluded_edges"),0,Integer.MAX_VALUE))throw new IOException();
        for(String name:List.of("node_counts","edge_counts")) {
            var counts=summary.path(name);long total=0;
            if(!counts.isObject()||counts.size()>512)throw new IOException();
            var rows=counts.fields();
            while(rows.hasNext()) {
                var row=rows.next();
                if(!row.getKey().matches("[A-Za-z][A-Za-z0-9_.]{0,255}")||!bounded(row.getValue(),0,Integer.MAX_VALUE))throw new IOException();
                total+=row.getValue().asInt();
            }
            if(total!=summary.path(name.equals("node_counts")?"nodes":"edges").asLong())throw new IOException();
        }
    }
    private void validateBuilderSelection(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","revision","preview_id","node_limit","request","summary"))||
            !body.path("contract_version").asText().equals("builder-selection-v1")||!bounded(body.path("revision"),0,Integer.MAX_VALUE)||
            !body.path("preview_id").asText().matches("[0-9a-f]{64}")||
            !fields(body.path("request")).equals(Set.of("mode","value")))throw new IOException();
        validateSelectionRequest(body.path("request"));validateSelectionSummary(body.path("summary"));
        if(body.path("request").path("mode").asText().equals("ALL")?!body.path("node_limit").isNull():
            !bounded(body.path("node_limit"),3,Integer.MAX_VALUE)||!body.path("node_limit").equals(body.path("summary").path("nodes")))throw new IOException();
    }
    private void validateBuilder(JsonNode body) throws IOException {
        String state=body.path("state").asText();var actions=body.path("actions");
        boolean extended=body.path("contract_version").asText().equals("builder-control-v3");
        boolean detail=extended||body.path("contract_version").asText().equals("builder-control-v2");
        var expected=new HashSet<>(Set.of("contract_version","state","run_id","target","progress","error_code","actions","delete_reason","production_write"));
        if(detail)expected.addAll(Set.of("stages","timing","binding","result"));
        if(!fields(body).equals(expected)||!Set.of("builder-control-v1","builder-control-v2","builder-control-v3").contains(body.path("contract_version").asText())||!Set.of("IDLE","RUNNING","STOPPING","STOPPED","COMPLETE","BLOCKED","ABANDONED","CLEARED").contains(state)||!extended&&Set.of("ABANDONED","CLEARED").contains(state)||
            !fields(actions).equals(extended?Set.of("build","stop","resume","delete","abandon"):Set.of("build","stop","resume","delete"))||!body.path("delete_reason").asText().equals("DELETE_NOT_AUTHORIZED")||!Set.of("BLOCKED","CONFIGURED").contains(body.path("production_write").asText()))throw new IOException();
        for(String name:fields(actions)) {
            boolean allowed=switch(name){case "build"->Set.of("IDLE","COMPLETE","ABANDONED","CLEARED").contains(state);case "stop"->state.equals("RUNNING");case "resume","abandon"->state.equals("STOPPED");default->false;};
            if(!actions.path(name).isBoolean()||(detail&&Set.of("build","resume").contains(name)?actions.path(name).asBoolean()&&!allowed:actions.path(name).asBoolean()!=allowed))throw new IOException();
        }
        var runId=body.path("run_id");
        if(runId.isNull()? !Set.of("IDLE","BLOCKED").contains(state): !runId.isTextual()||!runId.asText().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))throw new IOException();
        var target=body.path("target");
        if(target.isNull()? !state.equals("BLOCKED"): !fields(target).equals(Set.of("project_id","database","namespace"))||!bounded(target.path("project_id"),1,Integer.MAX_VALUE)||
            !target.path("database").asText().matches(body.path("production_write").asText().equals("CONFIGURED")?"[a-z][a-z0-9.-]{0,62}":"(?:neo4j|vietroadtraffic|freshsample[a-z0-9]{8,40})")||!target.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}"))throw new IOException();
        var progress=body.path("progress");
        if(!progress.isNull()&&(!fields(progress).equals(Set.of("stage","done","total"))||!Set.of("preflight","plan","vectorize","export-artifact","write-nodes","verify-nodes","write-edges","verify","release").contains(progress.path("stage").asText())||
            !bounded(progress.path("total"),0,Integer.MAX_VALUE)||!bounded(progress.path("done"),0,progress.path("total").asInt())))throw new IOException();
        var error=body.path("error_code");if(!error.isNull()&&(!error.isTextual()||!error.asText().matches("[A-Z_]{1,32}")))throw new IOException();
        if(detail)validateBuilderDetail(body);
    }
    private void validateBuilderDetail(JsonNode body) throws IOException {
        var stages=body.path("stages");var binding=body.path("binding");var result=body.path("result");var timing=body.path("timing");
        var expected=List.of("preflight","plan","vectorize","export-artifact","write-nodes","verify-nodes","write-edges","verify","release");
        if(!stages.isArray()||stages.size()>expected.size())throw new IOException();
        int position=0;
        for(var row:stages) {
            if(!fields(row).equals(Set.of("name","state","done","total","error_code"))||!row.path("name").asText().equals(expected.get(position++))||
                !Set.of("PENDING","RUNNING","COMPLETE","STOPPED","BLOCKED").contains(row.path("state").asText())||
                (row.path("state").asText().equals("PENDING")?!row.path("done").isNull()||!row.path("total").isNull():
                    !bounded(row.path("total"),0,Integer.MAX_VALUE)||!bounded(row.path("done"),0,row.path("total").asInt()))||
                row.path("state").asText().equals("COMPLETE")&&!row.path("done").equals(row.path("total"))||
                !row.path("error_code").isNull()&&!row.path("error_code").asText().matches("[A-Z_]{1,32}"))throw new IOException();
        }
        if(binding.isNull()) {
            if(!stages.isEmpty()||!timing.isNull()||!result.isNull()||body.path("state").asText().equals("COMPLETE"))throw new IOException();
            return;
        }
        var bindingFields=new HashSet<>(Set.of("run_id","scope","plan_sha256","config_sha256","model_identity","database_id","project_id","database","namespace"));
        if(binding.has("node_limit")) {
            bindingFields.add("node_limit");
            if(!binding.path("node_limit").isNull()&&!bounded(binding.path("node_limit"),3,Integer.MAX_VALUE)||!binding.path("scope").asText().equals("PRODUCTION"))throw new IOException();
        }
        if(stages.size()!=expected.size()||!fields(binding).equals(bindingFields)||
            !binding.path("run_id").equals(body.path("run_id"))||!Set.of("FRESH_SAMPLE","PRODUCTION").contains(binding.path("scope").asText())||
            binding.path("scope").asText().equals("PRODUCTION")!=body.path("production_write").asText().equals("CONFIGURED")||
            !binding.path("plan_sha256").asText().matches("[0-9a-f]{64}")||!binding.path("config_sha256").asText().matches("[0-9a-f]{64}")||
            !binding.path("database_id").asText().matches("[A-Za-z0-9._:-]{1,128}"))throw new IOException();
        for(String key:List.of("project_id","database","namespace"))if(!binding.path(key).equals(body.path("target").path(key)))throw new IOException();
        String identity=binding.path("model_identity").asText();int split=identity.lastIndexOf('|');
        if(split<1||!identity.substring(split+1).matches("[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}"))throw new IOException();
        var uri=java.net.URI.create(identity.substring(0,split));
        if(!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null)throw new IOException();
        if(!fields(timing).equals(Set.of("started_at","updated_at")))throw new IOException();
        java.time.OffsetDateTime.parse(timing.path("started_at").asText());java.time.OffsetDateTime.parse(timing.path("updated_at").asText());
        if(result.isNull()) {
            if(body.path("state").asText().equals("COMPLETE"))throw new IOException();
            return;
        }
        if(!body.path("state").asText().equals("COMPLETE")||!fields(result).equals(Set.of("nodes","edges","vectors","dimension","indexes","fingerprint","verified_at","chat_activation"))||
            !bounded(result.path("nodes"),0,Integer.MAX_VALUE)||!bounded(result.path("edges"),0,Integer.MAX_VALUE)||!bounded(result.path("vectors"),0,Integer.MAX_VALUE)||
            !bounded(result.path("dimension"),1,65536)||!bounded(result.path("indexes"),4,4)||!result.path("fingerprint").asText().matches("[0-9a-f]{64}")||
            !result.path("chat_activation").asText().equals("SEPARATE")||java.util.stream.StreamSupport.stream(stages.spliterator(),false).anyMatch(row->!row.path("state").asText().equals("COMPLETE")))throw new IOException();
        java.time.OffsetDateTime.parse(result.path("verified_at").asText());
    }
    public Map<String,Object> status() {
        return Map.of("liveness",probe("/v1/health","either"),
            "queryReadiness",probe("/v1/health?mode=ready&capability=query-v1","query"),
            "retrievalReadiness",probe("/v1/health?mode=ready&capability=retrieve","inspect"),
            "vectorRetrievalReadiness",probe("/v1/health?mode=ready&capability=retrieve-vector","inspect"),
            "release",probe("/v1/graph/release","either"));
    }
    public JsonNode pipelineStatus() { return inspectView("/v1/pipeline/status",true); }
    public JsonNode configuration() {
        try {
            String token=inspectionToken();
            return inspectionClient.get().uri("/v1/config").header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                if(res.getStatusCode().value()!=200||!List.of("no-store").equals(res.getHeaders().get(HttpHeaders.CACHE_CONTROL))) throw new IOException("Configuration unavailable");
                var body=inspectionBody(res,token);
                if(body.toString().length()>16384) throw new IOException("Configuration too large");
                validateConfiguration(body);return body;
            });
        } catch(Exception e) { throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Chưa đọc được cấu hình KAG. Vui lòng kiểm tra dịch vụ và quyền inspection."); }
    }
    public JsonNode llmCredentials(LLMCredentialsChangeRequest change) {
        if(change!=null&&(change.revision()==null||change.revision()<0||change.revision()>=Integer.MAX_VALUE||
            change.chat()==null&&change.embedding()==null||
            change.chat()!=null&&!llmOptions(change.chat(),true)||change.embedding()!=null&&!llmOptions(change.embedding(),true)))
            throw vn.luatgt.exception.ApiErrors.bad("Model, Base URL hoặc API key không hợp lệ");
        try {
            String token=change==null?inspectionToken():readToken(credentialsWriteTokenFile);
            if(change!=null)for(String file:List.of(tokenFile,inspectTokenFile,builderTokenFile)) {
                if(!file.isBlank()&&token.equals(readToken(file)))throw new IOException("Distinct credentials scope required");
            }
            RestClient.RequestHeadersSpec<?> request=change==null?inspectionClient.get().uri("/v1/config/models"):
                inspectionClient.post().uri("/v1/config/models").contentType(MediaType.APPLICATION_JSON).body(change);
            return request.header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                var body=inspectionBody(res,token);int status=res.getStatusCode().value();
                if(change!=null)for(JsonNode role:new JsonNode[]{change.chat(),change.embedding()}) {
                    if(role!=null&&role.has("api_key")&&body.toString().contains(role.path("api_key").asText()))throw new IOException("Credentials reflected");
                }
                if(status==409&&body.path("error").path("code").asText().equals("CONFIG_CONFLICT"))
                    throw new ResponseStatusException(HttpStatus.CONFLICT,"Cấu hình vừa thay đổi. Hãy tải lại trước khi lưu.");
                if(status==422)throw vn.luatgt.exception.ApiErrors.bad("Provider, model, Base URL hoặc API key không hợp lệ; lần lưu đầu mỗi nhóm cần key");
                if(status!=200||!List.of("no-store").equals(res.getHeaders().get(HttpHeaders.CACHE_CONTROL)))throw new IOException("Credentials metadata unavailable");
                validateLLMCredentials(body);return body;
            });
        } catch(ResponseStatusException e) {throw e;}
        catch(Exception e) {throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Không đọc hoặc lưu được cấu hình model. Kiểm tra dịch vụ, quyền credentials-write và storage.");}
    }
    private static boolean llmOptions(JsonNode value,boolean input) {
        if(value==null)return false;
        var keys=new HashSet<>(fields(value));
        if(value.has("provider")) {
            if(!value.path("provider").asText().equals("openai-compatible"))return false;
            keys.remove("provider");
        } else if(!input)return false;
        if(input?!(keys.equals(Set.of("base_url","model"))||keys.equals(Set.of("base_url","model","api_key"))):
            !keys.equals(Set.of("base_url","model","key_configured")))return false;
        if(!value.path("model").isTextual()||!value.path("model").asText().matches("[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}")||
            !value.path("base_url").isTextual()||value.path("base_url").asText().length()>2048||
            value.path("base_url").asText().matches("(?s).*[\\s\\x00-\\x1f\\x7f].*"))return false;
        try {
            var uri=new java.net.URI(value.path("base_url").asText());
            if(!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getPort()==0||uri.getPort()>65535||
                uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null)return false;
        } catch(Exception e) {return false;}
        return input?(!value.has("api_key")||value.path("api_key").isTextual()&&value.path("api_key").asText().matches("[!-~]{1,4096}")):
            value.path("key_configured").isBoolean()&&value.path("key_configured").asBoolean();
    }
    public JsonNode modelAction(String role,String action,ModelConfigActionRequest change) {
        if(!Set.of("chat","embedding").contains(role)||!Set.of("test","apply").contains(action)||change==null||
            change.revision()==null||change.revision()<0||change.revision()>=Integer.MAX_VALUE)
            throw vn.luatgt.exception.ApiErrors.bad("Thao tác model không hợp lệ");
        try {
            String selected=action.equals("test")?providerTestTokenFile:configApplyTokenFile;
            String token=readToken(selected);
            for(String file:List.of(tokenFile,inspectTokenFile,builderTokenFile,credentialsWriteTokenFile,
                    action.equals("test")?configApplyTokenFile:providerTestTokenFile))
                if(!file.isBlank()&&token.equals(readToken(file)))throw new IOException("Distinct model scope required");
            return client.post().uri("/v1/config/models/"+role+"/"+action).contentType(MediaType.APPLICATION_JSON).body(change)
                .header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                    var body=inspectionBody(res,token);int status=res.getStatusCode().value();
                    if(status==409)throw new ResponseStatusException(HttpStatus.CONFLICT,
                        body.path("error").path("code").asText().equals("CONFIG_BUSY")?
                        "Runtime hoặc kiểm thử đang bận. Hãy thử lại khi rảnh.":"Cấu hình vừa thay đổi. Hãy tải lại trước khi tiếp tục.");
                    if(status!=200||!List.of("no-store").equals(res.getHeaders().get(HttpHeaders.CACHE_CONTROL)))
                        throw new IOException("Model action unavailable");
                    validateLLMCredentials(body);return body;
                });
        } catch(ResponseStatusException e) {throw e;}
        catch(Exception e) {throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Không thực hiện được Test/Apply. Kiểm tra dịch vụ và quyền provider-test/config-apply; tải lại trạng thái trước khi thử tiếp.");}
    }
    private void validateLLMCredentials(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","revision","saved","chat","embedding","applied","connection_tested","save_allowed","error_code","roles","build_config"))||
            !body.path("contract_version").asText().equals("llm-credentials-v3")||!bounded(body.path("revision"),0,Integer.MAX_VALUE)||
            !body.path("saved").isBoolean()||!body.path("save_allowed").isBoolean()||!body.path("applied").isBoolean()||
            !body.path("connection_tested").isBoolean()||!body.path("error_code").isNull()&&
            !Set.of("CONFIG_INVALID","CONFIG_STORAGE_UNAVAILABLE").contains(body.path("error_code").asText()))throw new IOException("Invalid model metadata");
        if(body.path("saved").asBoolean()?body.path("revision").asInt()<1||body.path("chat").isNull()&&body.path("embedding").isNull()||
            !body.path("chat").isNull()&&!llmOptions(body.path("chat"),false)||!body.path("embedding").isNull()&&!llmOptions(body.path("embedding"),false):
            body.path("revision").asInt()!=0||!body.path("chat").isNull()||!body.path("embedding").isNull())throw new IOException("Invalid saved metadata");
        if((!body.path("error_code").isNull()||body.path("revision").asInt()==Integer.MAX_VALUE)&&body.path("save_allowed").asBoolean())throw new IOException("Invalid save authority");
        if(!fields(body.path("roles")).equals(Set.of("chat","embedding"))||
            !(body.path("build_config").equals(json.valueToTree(Map.of("state","SEPARATE","reason","BUILDER_CONFIGURATION_API")))||
              body.path("build_config").equals(json.valueToTree(Map.of("state","NOT_SUPPORTED","reason","BUILDER_REPLAY_ONLY")))))
            throw new IOException("Invalid consumer metadata");
        boolean applied=false,tested=false;
        for(String role:List.of("chat","embedding")) {
            var row=body.path("roles").path(role);var test=row.path("test");var active=row.path("active");
            if(!fields(row).equals(Set.of("saved_revision","test","active_revision","active","status","blocker","actions"))||
                !row.path("saved_revision").isNull()&&!bounded(row.path("saved_revision"),1,body.path("revision").asInt())||
                body.path(role).isNull()!=row.path("saved_revision").isNull()||
                !row.path("active_revision").isNull()&&!bounded(row.path("active_revision"),1,body.path("revision").asInt())||
                !active.isNull()&&!llmOptions(active,false)||
                !Set.of("NOT_CONFIGURED","SAVED","PENDING_APPLY","APPLIED","BLOCKED").contains(row.path("status").asText())||
                !fields(row.path("actions")).equals(Set.of("test","apply"))||!row.path("actions").path("test").isBoolean()||!row.path("actions").path("apply").isBoolean()||
                !row.path("blocker").isNull()&&!Set.of("TEST_REQUIRED","TEST_IN_PROGRESS","RELEASE_UNAVAILABLE","RELEASE_MISMATCH","VECTOR_IDENTITY_MISMATCH",
                    "ACTIVE_CONFIG_INVALID","PROXY_POLICY_UNVERIFIED","BLOCKED","AUTH_FAILED","MODEL_NOT_FOUND","RATE_LIMITED","PROVIDER_ERROR",
                    "MODEL_MISMATCH","DIMENSION_MISMATCH","INVALID_RESPONSE","TIMEOUT","NETWORK_ERROR").contains(row.path("blocker").asText()))
                throw new IOException("Invalid role metadata");
            if(!test.isNull()) {
                if(!fields(test).equals(Set.of("revision","status","code","dimension","observed_model","client_attempts","output_chars","tested_at"))||
                    !test.path("revision").equals(row.path("saved_revision"))||!Set.of("PASS","FAIL","BLOCKED").contains(test.path("status").asText())||
                    !test.path("code").equals(row.path("blocker"))&&!row.path("blocker").asText().matches("TEST_REQUIRED|TEST_IN_PROGRESS|RELEASE_UNAVAILABLE|RELEASE_MISMATCH|VECTOR_IDENTITY_MISMATCH|ACTIVE_CONFIG_INVALID|PROXY_POLICY_UNVERIFIED|BLOCKED")||
                    !bounded(test.path("client_attempts"),0,1)||!bounded(test.path("output_chars"),0,262144)||
                    !test.path("dimension").isNull()&&!bounded(test.path("dimension"),0,262144)||
                    !test.path("observed_model").isNull()&&(!test.path("observed_model").isTextual()||
                        !test.path("observed_model").asText().matches("[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}"))||
                    !test.path("tested_at").isTextual()||!test.path("tested_at").asText().matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\+00:00")||
                    test.path("status").asText().equals("PASS")&&(!test.path("code").isNull()||test.path("client_attempts").asInt()!=1||
                        (role.equals("embedding")?!bounded(test.path("dimension"),1,65536):test.path("output_chars").asInt()<1)))throw new IOException("Invalid provider result");
                tested|=test.path("status").asText().equals("PASS");
            }
            if(row.path("status").asText().equals("APPLIED")) {
                if(active.isNull()||!active.equals(body.path(role))||!row.path("active_revision").equals(row.path("saved_revision")))throw new IOException("Invalid active revision");
                applied=true;
            }
        }
        if(body.path("applied").asBoolean()!=applied||body.path("connection_tested").asBoolean()!=tested)throw new IOException("Invalid model state");
    }
    public JsonNode chatRetrieval(String action,ChatRetrievalChangeRequest change) {
        if(action!=null&&(!Set.of("save","apply","restore").contains(action)||change==null||change.revision()==null||change.revision()<0||
            (action.equals("save")?!retrievalValues(change.values()):change.values()!=null)))
            throw vn.luatgt.exception.ApiErrors.bad("Cấu hình Retrieval cần top_k nguyên từ 1 đến 10 và expand boolean");
        try {
            String token=inspectionToken();
            RestClient.RequestHeadersSpec<?> request;
            if(action==null)request=inspectionClient.get().uri("/v1/config/retrieval");
            else {
                String query=readToken(tokenFile);
                var body=new LinkedHashMap<String,Object>();body.put("revision",change.revision());
                if(action.equals("save"))body.put("values",change.values());
                request=inspectionClient.post().uri("/v1/config/retrieval/"+action).contentType(MediaType.APPLICATION_JSON)
                    .header("X-KAG-Config-Query-Authorization","Bearer "+query).body(body);
            }
            return request.header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                var body=inspectionBody(res,token);int status=res.getStatusCode().value();
                if(status==409) {
                    String code=body.path("error").path("code").asText();
                    if(!Set.of("CONFIG_CONFLICT","CONFIG_BUSY").contains(code))throw new IOException("Invalid configuration conflict");
                    throw new ResponseStatusException(HttpStatus.CONFLICT,code.equals("CONFIG_BUSY")?"Runtime đang bận hoặc chưa an toàn. Hãy thử lại khi rảnh.":"Cấu hình vừa thay đổi hoặc thao tác không còn phù hợp. Hãy tải lại trước khi tiếp tục.");
                }
                if(status!=200||!List.of("no-store").equals(res.getHeaders().get(HttpHeaders.CACHE_CONTROL)))throw new IOException("Configuration unavailable");
                validateChatRetrieval(body);return body;
            });
        } catch(ResponseStatusException e) {throw e;}
        catch(Exception e) {throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Không đọc hoặc ghi được cấu hình Retrieval. Kiểm tra dịch vụ, quyền truy cập và cấu hình đã lưu.");}
    }
    private static boolean retrievalValues(JsonNode value) {
        return value!=null&&fields(value).equals(Set.of("top_k","expand"))&&bounded(value.path("top_k"),1,10)&&value.path("expand").isBoolean();
    }
    private void validateChatRetrieval(JsonNode body) throws IOException {
        var active=body.path("active");var saved=body.path("saved");var previous=body.path("previous");var actions=body.path("actions");
        if(!fields(body).equals(Set.of("contract_version","revision","saved","active","previous","persisted","pending","runtime_idle","actions","error_code"))||
            !body.path("contract_version").asText().equals("chat-retrieval-v1")||!bounded(body.path("revision"),0,Integer.MAX_VALUE)||
            !fields(actions).equals(Set.of("save","apply","restore"))||!body.path("persisted").isBoolean()||!body.path("pending").isBoolean()||!body.path("runtime_idle").isBoolean()||
            (active.isNull()?!saved.isNull()||!previous.isNull()||body.path("error_code").isNull():!retrievalValues(active)||!retrievalValues(saved)||!previous.isNull()&&!retrievalValues(previous))||
            (!body.path("error_code").isNull()&&!Set.of("CONFIG_INVALID","CONFIG_STORAGE_UNAVAILABLE").contains(body.path("error_code").asText()))||
            body.path("pending").asBoolean()!=!saved.equals(active))throw new IOException("Invalid Chat retrieval configuration");
        boolean available=!active.isNull()&&body.path("error_code").isNull()&&body.path("revision").asInt()<Integer.MAX_VALUE,idle=body.path("runtime_idle").asBoolean();
        if(!actions.path("save").equals(json.valueToTree(available))||!actions.path("apply").equals(json.valueToTree(available&&idle&&body.path("pending").asBoolean()))||
            !actions.path("restore").equals(json.valueToTree(available&&idle&&!previous.isNull())))throw new IOException("Invalid configuration actions");
    }
    private void validateConfiguration(JsonNode body) throws IOException {
        var project=body.path("project");var models=body.path("models");var solver=body.path("solver");
        if(!fields(body).equals(Set.of("contract_version","project","models","solver"))||!body.path("contract_version").asText().equals("kag-config-v1")||
            !fields(project).equals(Set.of("source","release_id","release_state"))||!project.path("source").asText().equals("startup_environment")||
            !Set.of("NOT_CONFIGURED","LOADED","UNAVAILABLE").contains(project.path("release_state").asText())||
            (!project.path("release_id").isNull()&&(!project.path("release_id").isTextual()||!project.path("release_id").asText().matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,199}")))||
            (project.path("release_state").asText().equals("LOADED")&&project.path("release_id").isNull())||
            !fields(models).equals(Set.of("source","identity_verified","chat","embedding"))||!models.path("source").asText().equals("startup_environment")||
            !models.path("identity_verified").equals(json.valueToTree(false)))throw new IOException("Invalid configuration");
        for(String role:List.of("chat","embedding")) {
            var model=models.path(role);String state=model.path("state").asText();
            if(!fields(model).equals(Set.of("state","model","endpoint"))||!Set.of("CONFIGURED","NOT_CONFIGURED","INCOMPLETE","INVALID").contains(state)||
                (!model.path("model").isNull()&&(!model.path("model").isTextual()||!model.path("model").asText().matches("[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}")))||
                (!model.path("endpoint").isNull()&&(!text(model.path("endpoint"),270,true)||!configEndpoint(model.path("endpoint").asText()))))throw new IOException("Invalid model metadata");
            if(state.equals("CONFIGURED")&&(model.path("model").isNull()||model.path("endpoint").isNull())||
                state.equals("NOT_CONFIGURED")&&(!model.path("model").isNull()||!model.path("endpoint").isNull()))throw new IOException("Inconsistent model metadata");
        }
        if(solver.isNull())return;
        if(!fields(solver).equals(Set.of("source","pipeline","planner","top_k","expand","max_evidence_chars","max_iteration","search_k","expansion_limit","required_vector_dimensions"))||
            !solver.path("source").asText().equals("source_defaults")||!solver.path("pipeline").asText().equals("KAGIterativePipeline")||
            !solver.path("planner").asText().equals("KAGIterativePlanner")||!solver.path("expand").isBoolean())throw new IOException("Invalid solver metadata");
        for(String field:List.of("top_k","max_evidence_chars","max_iteration","search_k","expansion_limit","required_vector_dimensions"))
            if(!bounded(solver.path(field),1,1000000))throw new IOException("Invalid solver limit");
        if(solver.path("top_k").asInt()>solver.path("search_k").asInt())throw new IOException("Invalid retrieval limit");
    }
    private static boolean configEndpoint(String value) {
        try {
            var uri=java.net.URI.create(value);
            return Set.of("http","https").contains(uri.getScheme())&&uri.getHost()!=null&&uri.getUserInfo()==null&&
                uri.getRawPath().isEmpty()&&uri.getRawQuery()==null&&uri.getRawFragment()==null&&uri.getPort()<=65535;
        } catch(IllegalArgumentException e) {return false;}
    }
    public JsonNode benchmarkDatasets() { return inspectView("/v1/benchmark/datasets",false); }
    public JsonNode sampleInspection() {
        try {
            headerIdentity(release);String token=inspectionToken();
            return inspectionClient.get().uri("/v1/operations/sample").header(HttpHeaders.AUTHORIZATION,"Bearer "+token)
                .header("X-KAG-Release-ID",release).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                    if(res.getStatusCode().value()!=200) throw new IOException("Sample inspection unavailable");
                    var body=inspectionBody(res,token);validateSample(body);return body;
                });
        } catch(Exception e) { throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Inspection SAMPLE chưa đủ bằng chứng hoặc chưa khả dụng"); }
    }
    private void validateSample(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","release_id","release_kind","source_snapshot_id","source_catalog_sha256","schema_contract","graph_fingerprint","backend","counts","nodes","edges","verified_at","execution_allowed","production_write","sample_receipt","datasets","providers"))||
            !body.path("contract_version").asText().equals("h1-sample-inspection-1.0")||!body.path("release_id").asText().equals(release)||
            !body.path("release_kind").asText().equals("SAMPLE")||!body.path("schema_contract").equals(json.valueToTree(schema.identity()))||
            !text(body.path("source_snapshot_id"),512,true)||!body.path("execution_allowed").equals(json.valueToTree(false))||!body.path("production_write").asText().equals("BLOCKED")) throw new IOException("Invalid sample authority");
        for(String field:List.of("source_catalog_sha256","graph_fingerprint")) if(!body.path(field).asText().matches("[0-9a-f]{64}")) throw new IOException("Invalid sample hash");
        try {java.time.OffsetDateTime.parse(body.path("verified_at").asText());} catch(Exception e){throw new IOException("Invalid verification time");}
        var backend=body.path("backend");
        if(!fields(backend).equals(Set.of("database","namespace","database_id","server_id","read_only","verified"))||!backend.path("database").asText().equals("vietroadtraffic")||
            !backend.path("namespace").asText().equals("VietRoadTraffic")||!text(backend.path("database_id"),512,true)||!text(backend.path("server_id"),512,true)||
            !backend.path("read_only").equals(json.valueToTree(true))||!backend.path("verified").equals(json.valueToTree(true))) throw new IOException("Unverified backend");
        var counts=body.path("counts");var nodes=body.path("nodes");var edges=body.path("edges");
        if(!fields(counts).equals(Set.of("nodes","edges","vectors"))||!bounded(counts.path("nodes"),1,32)||!bounded(counts.path("edges"),0,22)||!bounded(counts.path("vectors"),1,42)||
            !nodes.isArray()||nodes.size()!=counts.path("nodes").asInt()||!edges.isArray()||edges.size()!=counts.path("edges").asInt()) throw new IOException("Invalid graph limits");
        var seen=new HashSet<String>();var sources=new HashSet<String>();
        for(var node:nodes) {
            String kind=node.path("entity_type").asText(),id=node.path("entity_id").asText();
            if(!fields(node).equals(Set.of("entity_type","entity_id","properties","sources"))||!Set.of("VietRoadTraffic.LegalDocument","VietRoadTraffic.LegalUnit","VietRoadTraffic.TrafficSign").contains(kind)||
                !text(node.path("entity_id"),512,true)||!seen.add(json.valueToTree(List.of(kind,id)).toString())||!node.path("properties").isObject()||!node.path("sources").isArray()||node.path("sources").isEmpty()||node.path("sources").size()>2) throw new IOException("Invalid graph node");
            var props=node.path("properties");var approved=new HashMap<String,String>();
            for(var row:schema.contract().path("node_properties").path(kind.substring(kind.lastIndexOf('.')+1))) approved.put(row.path("logical_name").asText(),row.path("contract_type").asText());
            if(!approved.keySet().containsAll(fields(props))||!props.path("id").asText().equals(id)||!props.path("name").asText().equals(id)) throw new IOException("Invalid node properties");
            for(var property:fields(props)) {
                var value=props.path(property);String type=approved.get(property);
                if(value.isNull())continue;
                if((type.equals("INTEGER")||type.equals("OPTIONAL_INTEGER"))?!value.isIntegralNumber():type.equals("JSON_TEXT")?false:!text(value,131072,false)) throw new IOException("Invalid property type");
            }
            for(var source:node.path("sources")) if(!fields(source).equals(Set.of("evidence_id","field","source_sha256"))||!source.path("evidence_id").asText().matches("[0-9a-f]{64}")||
                !source.path("source_sha256").asText().matches("[0-9a-f]{64}")||!approved.containsKey(source.path("field").asText())||!props.has(source.path("field").asText())||!sources.add(source.path("evidence_id").asText())) throw new IOException("Invalid provenance");
        }
        var seenEdges=new HashSet<String>();
        for(var edge:edges) {
            var rule=schema.contract().path("relations").path(edge.path("predicate").asText());
            if(!fields(edge).equals(Set.of("from","predicate","to","properties"))||rule.isMissingNode()||!edge.path("properties").isObject()||!seenEdges.add(edge.toString())) throw new IOException("Invalid edge");
            for(String side:List.of("from","to")) {
                var endpoint=edge.path(side);
                if(!endpoint.isArray()||endpoint.size()!=2||!seen.contains(endpoint.toString())||!endpoint.path(0).asText().equals("VietRoadTraffic."+rule.path(side+"_type").asText())) throw new IOException("Invalid edge endpoint");
            }
            var approved=new HashSet<String>();for(var row:schema.contract().path("relation_properties").path(edge.path("predicate").asText()))approved.add(row.path("logical_name").asText());
            if(!approved.containsAll(fields(edge.path("properties"))))throw new IOException("Invalid relation properties");
        }
        var receipt=body.path("sample_receipt");
        if(!fields(receipt).equals(Set.of("stage","sealed_at","receipt_sha256","build_run_id","progress"))||!receipt.path("stage").asText().equals("GRAPH_VERIFIED")||
            !receipt.path("receipt_sha256").asText().matches("[0-9a-f]{64}")||!receipt.path("build_run_id").isNull()||!receipt.path("progress").isNull()) throw new IOException("Invalid sample receipt");
        try{java.time.Instant.parse(receipt.path("sealed_at").asText());}catch(Exception e){throw new IOException("Invalid seal time");}
        validateDatasets(body.path("datasets"),true);validateProviders(body.path("providers"));
        for(var row:body.at("/datasets/datasets")) if(row.has("smoke")&&!row.at("/smoke/graph_fingerprint").equals(body.path("graph_fingerprint"))) throw new IOException("Smoke graph mismatch");
    }
    private static boolean bounded(JsonNode value,int min,int max) {return value.isIntegralNumber()&&value.canConvertToInt()&&value.asInt()>=min&&value.asInt()<=max;}
    private void validateProviders(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("state","attempts","receipt_window","configured_chat_model","configured_embedding_model","policy_response_version","exact_backend_identity_verified","upstream_attempts","proxy_retries"))||
            !body.path("exact_backend_identity_verified").equals(json.valueToTree(false))||!body.path("upstream_attempts").isNull()||!body.path("proxy_retries").isNull()||
            !Set.of("NOT_CONFIGURED","OBSERVED").contains(body.path("state").asText()))throw new IOException("Invalid provider claims");
        if(body.path("state").asText().equals("NOT_CONFIGURED")) {
            if(!body.path("attempts").isNull()||!body.path("receipt_window").isNull())throw new IOException("Unobserved provider counts");return;
        }
        for(String name:List.of("configured_chat_model","configured_embedding_model","policy_response_version"))
            if(!(name.equals("policy_response_version")&&body.path(name).isNull())&&(!body.path(name).isTextual()||!body.path(name).asText().matches("[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}")))throw new IOException("Invalid model route");
        var counts=body.path("attempts");if(!fields(counts).equals(Set.of("embedding","chat")))throw new IOException("Invalid request counts");
        for(var count:counts)if(!count.isIntegralNumber()||!count.canConvertToLong()||count.asLong()<0)throw new IOException("Invalid request count");
        var window=body.path("receipt_window");
        if(!fields(window).equals(Set.of("since","outcomes","recent"))||!window.path("recent").isArray()||window.path("recent").size()>50||!fields(window.path("outcomes")).equals(Set.of("embedding","chat")))throw new IOException("Invalid receipt window");
        try{java.time.OffsetDateTime.parse(window.path("since").asText());}catch(Exception e){throw new IOException("Invalid receipt time");}
        for(var outcome:window.path("outcomes")) {
            if(!fields(outcome).equals(Set.of("http_success","http_error","transport_error","cancelled")))throw new IOException("Invalid outcome counts");
            for(var count:outcome)if(!count.isIntegralNumber()||!count.canConvertToLong()||count.asLong()<0)throw new IOException("Invalid outcome count");
        }
        for(var row:window.path("recent")) {
            if(!fields(row).equals(Set.of("kind","attempt","outbound_id","request_id","source_component","configured_model","timestamp","outcome","status","provider_request_id","latency_ms","client_retry","proxy_retries","upstream_attempts"))||
                !Set.of("embedding","chat").contains(row.path("kind").asText())||!row.path("attempt").isIntegralNumber()||row.path("attempt").asLong()<1||
                !row.path("outbound_id").asText().matches("[0-9a-f]{32}")||!Set.of("kag.query","kag.retrieve","direct_runner").contains(row.path("source_component").asText())||
                !Set.of("attempted","http_success","http_error","transport_error","cancelled").contains(row.path("outcome").asText())||
                !row.path("client_retry").equals(json.valueToTree(false))||!row.path("proxy_retries").isNull()||!row.path("upstream_attempts").isNull()||
                !row.path("configured_model").asText().equals(body.path(row.path("kind").asText().equals("chat")?"configured_chat_model":"configured_embedding_model").asText()))throw new IOException("Invalid provider receipt");
            for(String id:List.of("request_id","provider_request_id"))if(!row.path(id).isNull()&&!row.path(id).asText().matches("[A-Za-z0-9_.:-]{1,128}"))throw new IOException("Invalid request identity");
            if(!row.path("status").isNull()&&!bounded(row.path("status"),100,599)||!row.path("latency_ms").isNull()&&(!row.path("latency_ms").isNumber()||!Double.isFinite(row.path("latency_ms").asDouble())||row.path("latency_ms").asDouble()<0))throw new IOException("Invalid receipt measurement");
            try{java.time.OffsetDateTime.parse(row.path("timestamp").asText());}catch(Exception e){throw new IOException("Invalid receipt timestamp");}
        }
    }
    private JsonNode inspectView(String path,boolean pipeline) {
        try {
            String token=inspectionToken();
            return inspectionClient.get().uri(path).header(HttpHeaders.AUTHORIZATION,"Bearer "+token).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                if(res.getStatusCode().value()!=200) throw new IOException("Inspection unavailable");
                var body=inspectionBody(res,token);
                if(!body.path("contract_version").asText().equals("h1-inspect-v1.0")||!body.path("execution_allowed").isBoolean()||body.path("execution_allowed").asBoolean()) throw new IOException("Invalid inspection authority");
                if(pipeline) validatePipeline(body); else validateDatasets(body);
                return body;
            });
        } catch(Exception e) { throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Inspection KAG chưa khả dụng hoặc chưa được cấu hình"); }
    }
    private void validatePipeline(JsonNode body) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","phase","active_requests","draining","closed","progress","execution_allowed","operational_proof","production_write","provider_egress"))||
            !body.path("progress").isNull()||!body.path("operational_proof").asText().equals("DENY")||!body.path("production_write").asText().equals("BLOCKED")||!body.path("provider_egress").asText().equals("DENY")) throw new IOException("Invalid pipeline proof");
        String phase=body.path("phase").asText();var active=body.path("active_requests");
        if(phase.equals("unavailable")) {
            if(!active.isNull()||!body.path("closed").isNull()||!body.path("draining").isNull()) throw new IOException("Invalid unavailable runtime");
            return;
        }
        if(!active.isIntegralNumber()||!active.canConvertToInt()||active.asInt()<0||active.asInt()>1||!body.path("closed").isBoolean()||!body.path("draining").isBoolean()) throw new IOException("Invalid runtime state");
        String observed=body.path("closed").asBoolean()?"closed":body.path("draining").asBoolean()?"draining":active.asInt()==1?"running":"idle";
        if(!phase.equals(observed)) throw new IOException("Inconsistent runtime state");
    }
    private void validateDatasets(JsonNode body) throws IOException { validateDatasets(body,false); }
    private void validateDatasets(JsonNode body,boolean sample) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","state","datasets","execution_allowed","execution_blockers","metrics"))||!body.path("metrics").isNull()||
            !body.path("execution_blockers").equals(json.valueToTree(List.of("OPERATIONAL_PROOF_REQUIRED","BENCHMARK_EXECUTION_NOT_AUTHORIZED")))||
            !Set.of("AVAILABLE","NOT_CONFIGURED","UNAVAILABLE","LIMIT_EXCEEDED").contains(body.path("state").asText())||!body.path("datasets").isArray()||body.path("datasets").size()>20||
            (!body.path("state").asText().equals("AVAILABLE")&&!body.path("datasets").isEmpty())) throw new IOException("Invalid dataset catalog");
        var seen=new HashSet<String>();
        for(var row:body.path("datasets")) {
            String id=row.path("id").asText(),status=row.path("dataset_status").asText(),eligibility=row.path("dataset_eligibility").asText();
            var expected=new HashSet<String>(Set.of("id","dataset_status","dataset_eligibility","reason","dataset_hash","record_count","official_benchmark"));
            if(sample)expected.addAll(Set.of("eligible_count","ineligible_count","invalid_count","gold_count","missing_gold","eligibility_scope"));
            if(sample&&row.has("smoke"))expected.add("smoke");
            if(sample&&row.has("metadata"))expected.add("metadata");
            if(!fields(row).equals(expected)||!id.matches("[A-Za-z0-9_.-]{1,128}(?:/eval_questions\\.jsonl)?")||
                id.startsWith("../")||!seen.add(id)||!row.path("official_benchmark").isBoolean()||!Set.of("ELIGIBLE","BLOCKED").contains(eligibility)) throw new IOException("Invalid dataset identity");
            if(!row.path("dataset_status").isNull()&&!Set.of("PROVISIONAL","FROZEN").contains(status)) throw new IOException("Invalid dataset status");
            if(!row.path("dataset_hash").isNull()&&!row.path("dataset_hash").asText().matches("[0-9a-f]{64}")) throw new IOException("Invalid dataset hash");
            if(!row.path("record_count").isNull()&&(!row.path("record_count").isIntegralNumber()||!row.path("record_count").canConvertToLong()||row.path("record_count").asLong()<(sample?0:1))) throw new IOException("Invalid dataset count");
            if(eligibility.equals("ELIGIBLE")) {
                if(!status.equals("FROZEN")||row.path("dataset_hash").isNull()||row.path("record_count").isNull()||!row.path("reason").isNull()) throw new IOException("Unverified dataset eligibility");
            } else if(!Set.of("PROVISIONAL_DATASET","NO_GOLD","INVALID_DATASET","DATASET_TOO_LARGE").contains(row.path("reason").asText())&&!(sample&&row.path("reason").asText().equals("NO_ELIGIBLE_QUESTIONS"))) throw new IOException("Invalid blocked dataset");
            if(row.path("official_benchmark").asBoolean()&&!status.equals("FROZEN")) throw new IOException("Unverified official dataset");
            if(sample) {
                if(row.has("metadata")) {
                    var meta=row.path("metadata");
                    if(!fields(meta).equals(Set.of("dataset_version","category_counts","generation_method"))||!meta.path("category_counts").isObject()||
                        (!meta.path("dataset_version").isNull()&&!text(meta.path("dataset_version"),512,true))||
                        (!meta.path("generation_method").isNull()&&!meta.path("generation_method").asText().equals("legacy-b2-evidence-first-adapted")))throw new IOException("Invalid dataset metadata");
                    long totalCategories=0;
                    var categories=meta.path("category_counts").fields();
                    while(categories.hasNext()) {var entry=categories.next();if(!Set.of("definition","obligation","sanction_numeric","effectiveness_metadata","inter_document","multi_hop","unanswerable","traffic_sign").contains(entry.getKey())||!bounded(entry.getValue(),1,1000000))throw new IOException("Invalid question category");totalCategories+=entry.getValue().asLong();}
                    if(!row.path("record_count").isNull()&&(totalCategories!=row.path("record_count").asLong()-row.path("invalid_count").asLong()||
                        (meta.path("dataset_version").isNull()!=(totalCategories==0))))throw new IOException("Inconsistent category counts");
                }
                if(row.has("smoke"))validateSmoke(row.path("smoke"),row.path("record_count"),row);
                if(!row.path("eligibility_scope").asText().equals("G1_RETRIEVAL_GOLD_COVERAGE")||!bounded(row.path("eligible_count"),0,1000000)||!bounded(row.path("ineligible_count"),0,1000000)||
                    !fields(row.path("missing_gold")).equals(Set.of("document","unit","sign")))throw new IOException("Invalid sample coverage");
                for(var ids:row.path("missing_gold")) {if(!ids.isArray()||ids.size()>10000)throw new IOException("Invalid missing gold");for(var idValue:ids)if(!text(idValue,512,true))throw new IOException("Invalid gold identity");}
                if(!row.path("record_count").isNull()&&(!bounded(row.path("invalid_count"),0,1000000)||!bounded(row.path("gold_count"),0,row.path("record_count").asInt())||
                    row.path("eligible_count").asLong()+row.path("ineligible_count").asLong()+row.path("invalid_count").asLong()!=row.path("record_count").asLong()))throw new IOException("Inconsistent coverage counts");
            }
        }
    }
    private void validateSmoke(JsonNode smoke,JsonNode total,JsonNode dataset) throws IOException {
        if(!fields(smoke).equals(Set.of("state","review_status","g1_eligible_count","graph_fingerprint","official_benchmark","runs"))||
            !Set.of("NOT_RUN","AVAILABLE","INVALID_RECEIPT").contains(smoke.path("state").asText())||
            !Set.of("PROVISIONAL","FROZEN","NOT_ATTESTED").contains(smoke.path("review_status").asText())||
            (!smoke.path("review_status").asText().equals("NOT_ATTESTED")&&!smoke.path("review_status").equals(dataset.path("dataset_status")))||
            !bounded(smoke.path("g1_eligible_count"),0,total.isIntegralNumber()?total.asInt():0)||
            !smoke.path("graph_fingerprint").asText().matches("[0-9a-f]{64}")||!smoke.path("official_benchmark").isBoolean()||!smoke.path("official_benchmark").equals(dataset.path("official_benchmark"))||
            !fields(smoke.path("runs")).equals(Set.of("G1","G2")))throw new IOException("Invalid smoke proof");
        boolean available=smoke.path("state").asText().equals("AVAILABLE"),hasRun=false;
        for(var run:smoke.path("runs")) {
            if(run.isNull())continue;hasRun=true;
            var runFields=new HashSet<String>(Set.of("status","started_at","finished_at","requested_count","attempted_count","failed_count","ineligible_count","metrics","latency_ms"));
            if(run.has("configuration"))runFields.add("configuration");
            if(!available||!Set.of("PROVISIONAL","FROZEN").contains(smoke.path("review_status").asText())||!fields(run).equals(runFields)||
                !run.path("status").asText().equals("COMPLETE")||!bounded(run.path("requested_count"),1,1000000)||!run.path("requested_count").equals(total)||
                !bounded(run.path("attempted_count"),0,total.asInt())||!bounded(run.path("failed_count"),0,run.path("attempted_count").asInt())||
                !bounded(run.path("ineligible_count"),0,total.asInt())||run.path("attempted_count").asInt()+run.path("ineligible_count").asInt()!=total.asInt()||
                !run.path("metrics").isObject()||run.path("metrics").size()>128||!fields(run.path("latency_ms")).equals(Set.of("successful","all_attempted")))throw new IOException("Invalid smoke run");
            if(run.has("configuration")) {
                var config=run.path("configuration");
                if(!fields(config).equals(Set.of("protocol_version","eval_version","metric_policy_version","ks","top_k","expand","rank_semantics","identity_catalog_hash","release_id","judge_config"))||
                    !config.path("protocol_version").asText().equals("1.0")||!config.path("eval_version").asText().equals("1.0")||!Set.of("1.0","1.1").contains(config.path("metric_policy_version").asText())||
                    !bounded(config.path("top_k"),1,10)||!config.path("ks").isArray()||config.path("ks").isEmpty()||config.path("ks").size()>10||
                    !config.path("expand").equals(json.valueToTree(false))||!config.path("rank_semantics").asText().equals("channel_projected_returned_top_k")||
                    (!config.path("identity_catalog_hash").isNull()&&!config.path("identity_catalog_hash").asText().matches("[0-9a-f]{64}"))||
                    (!config.path("release_id").isNull()&&!config.path("release_id").asText().equals(release)))throw new IOException("Invalid benchmark configuration");
                int previous=0;for(var k:config.path("ks")){if(!bounded(k,1,config.path("top_k").asInt())||k.asInt()<=previous)throw new IOException("Invalid benchmark cutoffs");previous=k.asInt();}
                var judge=config.path("judge_config");
                if(!judge.isNull()) {
                    if(!fields(judge).equals(Set.of("name","version","model","prompt_version","temperature","seed","calibrated"))||!text(judge.path("name"),512,true)||
                        !judge.path("version").isTextual()||!judge.path("model").isTextual()||!judge.path("prompt_version").isTextual()||!judge.path("temperature").isNumber()||!Double.isFinite(judge.path("temperature").asDouble())||
                        !judge.path("calibrated").isBoolean()||!judge.path("seed").isNull()&&(!judge.path("seed").isIntegralNumber()||!judge.path("seed").canConvertToLong()))throw new IOException("Invalid judge configuration");
                }
            }
            try {if(java.time.Instant.parse(run.path("finished_at").asText()).isBefore(java.time.Instant.parse(run.path("started_at").asText())))throw new IOException("Invalid smoke timestamps");}
            catch(java.time.format.DateTimeParseException invalid){throw new IOException("Invalid smoke timestamps");}
            for(var metric:run.path("metrics")) {
                if(!fields(metric).equals(Set.of("value","scored_count","status_counts","eligible_count","excluded_count","failed_count"))||
                    !fields(metric.path("status_counts")).equals(Set.of("OK","NOT_APPLICABLE","UNAVAILABLE","UNKNOWN"))||
                    (!metric.path("value").isNull()&&(!metric.path("value").isNumber()||!Double.isFinite(metric.path("value").asDouble())||metric.path("value").asDouble()<0)))throw new IOException("Invalid smoke metric");
                for(String k:List.of("scored_count","eligible_count","excluded_count","failed_count"))if(!bounded(metric.path(k),0,total.asInt()))throw new IOException("Invalid smoke metric count");
                int statusCount=0;for(var count:metric.path("status_counts")){if(!bounded(count,0,total.asInt()))throw new IOException("Invalid metric status");statusCount+=count.asInt();}
                if(statusCount!=total.asInt()||metric.path("eligible_count").asInt()+metric.path("excluded_count").asInt()!=total.asInt()||
                    metric.path("scored_count").asInt()!=metric.at("/status_counts/OK").asInt()||(metric.path("value").isNull()!=(metric.path("scored_count").asInt()==0)))throw new IOException("Inconsistent smoke metrics");
            }
            for(var latency:run.path("latency_ms")) {
                if(!fields(latency).equals(Set.of("count","min","mean","median","p95","max"))||!bounded(latency.path("count"),0,total.asInt()))throw new IOException("Invalid smoke latency");
                for(String k:List.of("min","mean","median","p95","max"))if(latency.path("count").asInt()==0?!latency.path(k).isNull():!latency.path(k).isNumber()||!Double.isFinite(latency.path(k).asDouble())||latency.path(k).asDouble()<0)throw new IOException("Invalid smoke latency");
            }
        }
        if(available!=hasRun)throw new IOException("Missing smoke execution");
    }
    private String inspectionToken() throws IOException {
        if(inspectTokenFile.isBlank()||!Path.of(inspectTokenFile).isAbsolute()) throw new IOException("Inspection credentials unavailable");
        String token=readToken(inspectTokenFile);
        if(!tokenFile.isBlank()) {
            String query=null; try { query=readToken(tokenFile); } catch(IOException ignored) {}
            if(token.equals(query)) throw new IOException("Distinct scopes required");
        }
        return token;
    }
    private Map<String,Object> probe(String path,String scope) {
        String token;
        try {
            if(scope.equals("inspect")) token=inspectionToken();
            else if(scope.equals("query")) token=readToken(tokenFile);
            else { try { token=readToken(tokenFile); } catch(IOException unavailable) { token=inspectionToken(); } }
        } catch(Exception e) { return Map.of("state","NOT_CONFIGURED","code","NOT_CONFIGURED","httpStatus",0); }
        final String sentToken=token;
        int[] observed={0};
        try {
            String observedRelease=release;
            if(path.contains("mode=ready")&&!path.endsWith("retrieve-vector"))try {observedRelease=activePins().release();}catch(Exception ignored) {}
            final String expectedRelease=observedRelease;
            return servingClient.get().uri(path).header(HttpHeaders.AUTHORIZATION,"Bearer "+sentToken).header("X-KAG-Release-ID",expectedRelease).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
                int code=res.getStatusCode().value(); observed[0]=code; var body=inspectionBody(res,sentToken);
                if(code!=200) {
                    String error=errorCode(body);
                    if(code==503&&error.equals("NOT_READY")&&path.contains("mode=ready")) {
                        String capability=path.endsWith("retrieve-vector")?"retrieve-vector":scope.equals("inspect")?"retrieve":"query-v1";
                        if(!body.path("capability").asText().equals(capability)||!body.path("status").asText().equals("unavailable")||!body.path("checks").isObject()||
                            !fields(body.path("checks")).containsAll(Set.of("auth","runtime","sources"))||!Set.of("auth","runtime","sources","admission").containsAll(fields(body.path("checks")))||
                            !body.path("production_write").asText().equals("blocked")||!body.path("provider_transport").asText().equals("not_probed")) throw new IOException("Invalid readiness");
                        for(var check:body.path("checks")) if(!check.isTextual()||!Set.of("pass","blocked","unknown").contains(check.asText())) throw new IOException("Invalid readiness check");
                        return Map.<String,Object>of("state","NOT_READY","httpStatus",code,"code",error,"evidence",Map.of("capability",capability,"checks",body.path("checks"),"provider_transport","not_probed","production_write","blocked"));
                    }
                    return Map.<String,Object>of("state",code==503&&error.equals("RELEASE_UNAVAILABLE")?"RELEASE_UNAVAILABLE":code==401||code==403?"NOT_CONFIGURED":"UNAVAILABLE","httpStatus",code,"code",error);
                }
                if(path.equals("/v1/health")) {
                    if(!fields(body).equals(Set.of("contract_version","status"))||!body.path("contract_version").asText().equals("h1-read-v1.0")||!body.path("status").asText().equals("alive")) throw new IOException("Invalid liveness");
                    return Map.<String,Object>of("state","ALIVE","httpStatus",200);
                }
                if(path.equals("/v1/graph/release")) {
                    validateRelease(body);
                    // H1 release_view verifies artifacts only; it cannot certify live graph readiness.
                    return Map.<String,Object>of("state","NOT_READY","httpStatus",200,"code","ARTIFACTS_ONLY","evidence",body);
                }
                String capability=path.endsWith("retrieve-vector")?"retrieve-vector":scope.equals("inspect")?"retrieve":"query-v1";
                if(capability.equals("retrieve-vector")) {
                    if(!fields(body).equals(Set.of("status","capability","release_kind","release_id","provider_transport","production_write"))||
                        !body.path("status").asText().equals("ready")||!body.path("capability").asText().equals(capability)||
                        !body.path("release_kind").asText().equals("SAMPLE")||!body.path("release_id").asText().equals(release)||
                        !body.path("provider_transport").asText().equals("not_probed")||!body.path("production_write").asText().equals("blocked"))throw new IOException("Invalid vector readiness");
                    return Map.<String,Object>of("state","READY","httpStatus",200,"evidence",body);
                }
                if(!fields(body).equals(Set.of("status","capability","release_kind","release_id","checks","provider_transport","production_write"))||
                    !body.path("status").asText().equals("ready")||!body.path("capability").asText().equals(capability)||
                    !Set.of("SAMPLE","PRODUCTION").contains(body.path("release_kind").asText())||!body.path("release_id").asText().equals(expectedRelease)||expectedRelease.isBlank()||
                    !body.path("provider_transport").asText().equals("metadata_verified")||!body.path("production_write").asText().equals("blocked")||
                    !fields(body.path("checks")).equals(Set.of("auth","runtime","sources","admission"))) throw new IOException("Invalid sample readiness");
                for(var check:body.path("checks")) if(!check.isTextual()||!check.asText().equals("pass")) throw new IOException("Invalid readiness check");
                return Map.<String,Object>of("state","READY","httpStatus",200,"evidence",body);
            });
        } catch(Exception e) { return Map.of("state","UNAVAILABLE","httpStatus",observed[0],"code",observed[0]==0?"UNAVAILABLE":"INVALID_RESPONSE"); }
    }
    public JsonNode retrieve(String message,int topK,boolean expand) {
        try {
            if(!text(json.valueToTree(message),4000,true)||topK<1||topK>10) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,"Yêu cầu truy xuất không hợp lệ");
            var pins=activePins();String token=inspectionToken();
            byte[] request=json.writeValueAsBytes(Map.of("message",message,"top_k",topK,"expand",expand,"schema_contract",pins.schema()));
            if(request.length>64*1024) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,"Yêu cầu truy xuất vượt giới hạn");
            return (pins.production()?client:inspectionClient).post().uri("/v1/retrieve").contentType(MediaType.APPLICATION_JSON).accept(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.AUTHORIZATION,"Bearer "+token).header("X-KAG-Release-ID",pins.release()).body(request).exchange((req,res)->{
                    var result=inspectionBody(res,token);
                    if(res.getStatusCode().value()!=200) {
                        String error=errorCode(result);
                        throw new ResponseStatusException(res.getStatusCode().value()==422?HttpStatus.UNPROCESSABLE_ENTITY:HttpStatus.SERVICE_UNAVAILABLE,
                            "Truy xuất KAG chưa khả dụng ("+error+")");
                    }
                    echo(res.getHeaders(),"X-KAG-Release-ID",pins.release()); validateRetrieval(result,pins); return result;
                });
        } catch(ResponseStatusException e) { throw e; }
        catch(Exception e) { throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Truy xuất KAG chưa khả dụng hoặc chưa được cấu hình"); }
    }
    private JsonNode inspectionBody(org.springframework.http.client.ClientHttpResponse response,String token) throws IOException {
        return inspectionBody(response,token,245760);
    }
    private JsonNode inspectionBody(org.springframework.http.client.ClientHttpResponse response,String token,int limit) throws IOException {
        var type=response.getHeaders().getContentType();
        if(type==null||!type.getType().equalsIgnoreCase("application")||!type.getSubtype().equalsIgnoreCase("json")||(type.getCharset()!=null&&!type.getCharset().equals(StandardCharsets.UTF_8))||response.getHeaders().containsKey(HttpHeaders.CONTENT_ENCODING)) throw new IOException("Invalid response media");
        byte[] bytes=response.getBody().readNBytes(limit+1); if(bytes.length>limit) throw new IOException("Response too large");
        var body=parse(StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString(),token);
        if(body==null||!body.isObject()) throw new IOException("Invalid response");
        for(String file:List.of(tokenFile,inspectTokenFile,credentialsWriteTokenFile,providerTestTokenFile,configApplyTokenFile)) {
            String other=null; try {other=readToken(file);} catch(IOException ignored) {}
            if(other!=null&&body.toString().contains(other)) throw new IOException("Credentials reflected");
        }
        return body;
    }
    private static String errorCode(JsonNode body) throws IOException {
        String code=body.path("error").path("code").asText();
        if(!Set.of("AUTH_REQUIRED","AUTH_INVALID","SCOPE_DENIED","INVALID_REQUEST","NOT_READY","RELEASE_UNAVAILABLE","QUERY_TIMEOUT","BACKEND_UNAVAILABLE","SCHEMA_CONTRACT_MISMATCH","RELEASE_MISMATCH","SOURCE_SNAPSHOT_MISMATCH","CONCURRENCY_LIMIT","RESULT_LIMIT_EXCEEDED","INTERNAL_ERROR","SOURCE_VALIDATION_FAILED","INVALID_NATIVE_RESULT","CONFIG_BUSY","CONFIG_CONFLICT").contains(code)) throw new IOException("Unknown error");
        return code;
    }
    private void validateRelease(JsonNode body) throws IOException {
        boolean production=body.path("release_kind").asText().equals("PRODUCTION");
        if(production) {
            var legacy=(com.fasterxml.jackson.databind.node.ObjectNode)body.deepCopy();legacy.remove("webapp_snapshot_id");
            boolean dataset=body.path("contract_version").asText().equals("h1-read-v1.2");
            if(dataset) {
                if(!body.path("source_mode").asText().equals("dataset-snapshot-v1")||!body.path("webapp_snapshot_id").isNull())throw new IOException("Invalid dataset source");
                legacy.remove("source_mode");
            }
            if(!dataset&&!body.path("contract_version").asText().equals("h1-read-v1.1")||!body.has("webapp_snapshot_id")||
                !body.path("webapp_snapshot_id").isNull()&&!text(body.path("webapp_snapshot_id"),512,true))throw new IOException("Invalid publication");
            validateMappedSchema(body.path("schema_contract"));
            legacy.put("contract_version","h1-read-v1.0");legacy.set("schema_contract",json.valueToTree(schema.identity()));
            validateRelease(legacy.put("release_kind","SAMPLE"));return;
        }
        if(!fields(body).equals(Set.of("contract_version","release_id","release_kind","schema_contract","source_snapshot_id","source_catalog_sha256","release_descriptor_sha256","graph_fingerprint","backend_identity_verified","source_identity_verified","verified_at","query_ready","production_write"))||
            !body.path("contract_version").asText().equals("h1-read-v1.0")||!body.path("schema_contract").equals(json.valueToTree(schema.identity()))||
            !text(body.path("release_id"),512,true)||!text(body.path("source_snapshot_id"),512,true)||!text(body.path("release_kind"),128,true)||
            !body.path("production_write").asText().equals("blocked")||!body.path("verified_at").isNull()) throw new IOException("Invalid release");
        for(String field:List.of("source_catalog_sha256","release_descriptor_sha256","graph_fingerprint")) if(!body.path(field).asText().matches("[0-9a-f]{64}")) throw new IOException("Invalid release hash");
        for(String field:List.of("backend_identity_verified","source_identity_verified","query_ready")) if(!body.path(field).isBoolean()||body.path(field).asBoolean()) throw new IOException("Unsupported release proof");
    }
    private void validateRetrieval(JsonNode body,Pins pins) throws IOException {
        if(!fields(body).equals(Set.of("contract_version","request_id","release_id","source_snapshot_id","schema_contract","items"))||!body.path("contract_version").asText().equals("h1-read-v1.1")||
            !body.path("release_id").asText().equals(pins.release())||!text(body.path("source_snapshot_id"),512,true)||!body.path("schema_contract").equals(pins.schema())||
            !body.path("items").isArray()||body.path("items").size()>110) throw new IOException("Invalid retrieval");
        if(!UUID.fromString(body.path("request_id").asText()).toString().equals(body.path("request_id").asText())) throw new IOException("Invalid request identity");
        validateRetrievalItems(body,pins.schema());
    }
    private void validateRetrievalItems(JsonNode body,JsonNode graphSchema) throws IOException {
        var seen=new HashSet<String>();
        for(var item:body.path("items")) {
            if(!fields(item).equals(Set.of("entity_type","entity_id","doc_id","unit_id","sign_id","source_texts","score","vector_sources","graph_context"))||
                !Set.of(graphSchema.path("namespace").asText()+".LegalUnit",graphSchema.path("namespace").asText()+".LegalDocument",graphSchema.path("namespace").asText()+".TrafficSign").contains(item.path("entity_type").asText())||!text(item.path("entity_id"),245760,true)||
                !seen.add(item.path("entity_type").asText()+"\u0000"+item.path("entity_id").asText())||!item.path("source_texts").isObject()||item.path("source_texts").isEmpty()||
                !item.path("vector_sources").isArray()||!item.path("graph_context").isArray()) throw new IOException("Invalid evidence");
            for(String id:List.of("doc_id","unit_id","sign_id")) if(!item.path(id).isNull()&&!text(item.path(id),245760,true)) throw new IOException("Invalid source identity");
            String id=item.path("entity_type").asText().endsWith("LegalUnit")?"unit_id":item.path("entity_type").asText().endsWith("TrafficSign")?"sign_id":"doc_id";
            if(!item.path("entity_id").equals(item.path(id))) throw new IOException("Source identity mismatch");
            for(var source:item.path("source_texts")) if(!source.isNull()&&!text(source,245760,false)) throw new IOException("Invalid source text");
            double max=-1; var properties=new HashSet<String>();
            for(var vector:item.path("vector_sources")) {
                if(!fields(vector).equals(Set.of("property","score","index"))||!text(vector.path("property"),512,true)||!text(vector.path("index"),512,true)||
                    !item.path("source_texts").has(vector.path("property").asText())||!properties.add(vector.path("property").asText())||!score(vector.path("score"))) throw new IOException("Invalid vector metadata");
                max=Math.max(max,vector.path("score").asDouble());
            }
            if(item.path("score").isNull()?max!=-1||item.path("graph_context").isEmpty():!score(item.path("score"))||item.path("score").asDouble()!=max) throw new IOException("Invalid evidence score");
            for(var edge:item.path("graph_context")) {
                if(!fields(edge).equals(Set.of("from","predicate","to"))||!text(edge.path("predicate"),512,true)) throw new IOException("Invalid graph metadata");
                boolean incident=false;
                for(String side:List.of("from","to")) {
                    var endpoint=edge.path(side); if(!endpoint.isArray()||endpoint.size()!=2||!text(endpoint.get(0),512,true)||!text(endpoint.get(1),245760,true)) throw new IOException("Invalid graph endpoint");
                    incident|=endpoint.get(0).equals(item.path("entity_type"))&&endpoint.get(1).equals(item.path("entity_id"));
                }
                if(!incident) throw new IOException("Unrelated graph metadata");
            }
        }
    }
    private static boolean score(JsonNode value) {return value.isNumber()&&Double.isFinite(value.asDouble())&&value.asDouble()>=0&&value.asDouble()<=1;}
    public JsonNode trialGraph(int projectId,String runId,vn.luatgt.dto.KagRetrieveRequest input) {
        if(projectId<1||runId==null||!runId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Chọn project và phiên dựng");
        try {
            String token=inspectionToken();
            var request=servingClient.post().uri("/v1/serving/trial/"+projectId+"/"+runId).contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.AUTHORIZATION,"Bearer "+token);
            String session=openSpgSession();if(session!=null)request.header("X-OpenSPG-Session",session);
            return request.body(input).exchange((req,res)->{
                var body=inspectionBody(res,token);
                if(res.getStatusCode().value()!=200) {
                    String code=errorCode(body);
                    String message=switch(code) {
                        case "QUERY_TIMEOUT" -> "Chưa đọc xong kết quả trong thời gian cho phép. Đợi lượt xử lý kết thúc rồi thử lại";
                        case "CONFIG_BUSY","CONCURRENCY_LIMIT" -> "Đồ thị đang được xử lý. Chờ rồi thử lại";
                        case "SCOPE_DENIED" -> "Đăng nhập lại OpenSPG và kiểm quyền sở hữu project";
                        case "RELEASE_MISMATCH" -> "Embedding đã lưu không khớp phiên dựng. Chỉnh model phù hợp rồi thử lại";
                        default -> "Chưa thể thử đồ thị. Kiểm kết nối, phiên dựng và model đã lưu";
                    };
                    throw new ResponseStatusException(HttpStatus.CONFLICT,message+" ("+code+")");
                }
                if(!fields(body).equals(Set.of("contract_version","project_id","run_id","schema_contract","model_identity","dimension","graph_fingerprint","items"))||
                    !body.path("contract_version").asText().equals("builder-retrieval-v1")||body.path("project_id").asInt()!=projectId||!body.path("run_id").asText().equals(runId)||
                    !text(body.path("model_identity"),4096,true)||!bounded(body.path("dimension"),1,65536)||!body.path("graph_fingerprint").asText().matches("[0-9a-f]{64}")||
                    !body.path("items").isArray()||body.path("items").size()>110)throw new IOException("Invalid selected graph result");
                validateMappedSchema(body.path("schema_contract"));validateRetrievalItems(body,body.path("schema_contract"));return body;
            });
        }catch(ResponseStatusException e){throw e;}
        catch(Exception e){throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Chưa đọc được kết quả thử đồ thị; lựa chọn Chat được giữ nguyên");}
    }
    public JsonNode query(Object request) {
        try {
            var admitted=admit(request);
            return breaker.executeSupplier(() -> post("/v1/query",admitted).exchange((req,res) -> {
                if(!res.getStatusCode().is2xxSuccessful()) return abstained(res,admitted);
                verifyHeaders(res.getHeaders(),admitted,MediaType.APPLICATION_JSON);
                byte[] bytes=res.getBody().readNBytes(256*1024+1);
                if(bytes.length>256*1024) throw new IOException("KAG response too large");
                var result=parse(StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString(),admitted.token());
                validateResult(result,admitted); currentDate(admitted.date()); return result;
            }));
        } catch(Exception e) { throw unavailable(); }
    }
    public void stream(Object request,BiConsumer<String,JsonNode> consumer) {
        try {
            var admitted=admit(request);
            breaker.executeRunnable(() -> post("/v1/query/stream",admitted).accept(MediaType.TEXT_EVENT_STREAM).exchange((req,res) -> {
                if(!res.getStatusCode().is2xxSuccessful()) { consumer.accept("done",abstained(res,admitted)); return null; }
                verifyHeaders(res.getHeaders(),admitted,MediaType.TEXT_EVENT_STREAM);
                try(var reader=new BufferedReader(new InputStreamReader(new LimitedInput(res.getBody()),StandardCharsets.UTF_8.newDecoder()))) {
                    String event="message",line; var payload=new StringBuilder(); boolean done=false;
                    while((line=reader.readLine())!=null) {
                        if(line.isEmpty()) {
                            if(payload.isEmpty()) continue;
                            if(!event.equals("delta")&&!event.equals("done")) throw new IOException("Unknown KAG event");
                            var result=parse(payload.toString(),admitted.token());
                            if(event.equals("done")) validateResult(result,admitted);
                            else if(!fields(result).equals(Set.of("text"))||!text(result.path("text"),4000,false)) throw new IOException("Invalid delta");
                            currentDate(admitted.date()); consumer.accept(event,result); payload.setLength(0);
                            if(event.equals("done")) { done=true; break; }
                            event="message";
                        } else if(line.startsWith("event:")) event=line.substring(6).trim();
                        else if(line.startsWith("data:")) { if(!payload.isEmpty()) payload.append('\n'); payload.append(line.substring(5).trim()); }
                    }
                    if(!done) throw new IOException("Incomplete KAG stream");
                }
                return null;
            }));
        } catch(Exception e) { throw unavailable(); }
    }
    private record Pins(String release,String snapshot,JsonNode schema,boolean production,boolean dataset,String descriptor) {
        String sourceHeader() { return dataset?"X-KAG-Source-Snapshot-ID":"X-WebApp-Snapshot-ID"; }
    }
    private void validateMappedSchema(JsonNode value) throws IOException {
        if(!fields(value).equals(Set.of("namespace","schema_sha256","contract_sha256"))||
            !value.path("namespace").asText().matches("[A-Za-z][A-Za-z0-9_]{0,63}")||
            !value.path("schema_sha256").asText().equals(schema.identity().get("schema_sha256"))||
            !value.path("contract_sha256").asText().matches("[0-9a-f]{64}"))throw new IOException("Invalid graph schema");
    }
    private Pins activePins() throws IOException {
        String token;
        try {token=inspectionToken();}catch(IOException e) {token=readToken(tokenFile);}
        String sent=token;
        return inspectionClient.get().uri("/v1/graph/release").header(HttpHeaders.AUTHORIZATION,"Bearer "+sent).accept(MediaType.APPLICATION_JSON).exchange((req,res)->{
            int status=res.getStatusCode().value();
            if(!release.isBlank()&&(status==404||status==503&&errorCode(inspectionBody(res,sent)).equals("RELEASE_UNAVAILABLE"))) {
                headerIdentity(release);return new Pins(release,snapshot,json.valueToTree(schema.identity()),false,false,"");
            }
            if(status!=200)throw new IOException("Release unavailable");
            var body=inspectionBody(res,sent);validateRelease(body);String id=body.path("release_id").asText();headerIdentity(id);
            if(body.path("release_kind").asText().equals("PRODUCTION")) {
                boolean dataset=body.path("source_mode").asText().equals("dataset-snapshot-v1");
                return new Pins(id,body.path(dataset?"source_snapshot_id":"webapp_snapshot_id").asText(""),body.path("schema_contract").deepCopy(),true,dataset,body.path("release_descriptor_sha256").asText());
            }
            if(!id.equals(release))throw new IOException("Release changed");
            return new Pins(release,snapshot,json.valueToTree(schema.identity()),false,false,"");
        });
    }
    private record Admitted(byte[] body,String token,LocalDate date,Pins pins) {}
    private JsonNode abstained(ClientHttpResponse response,Admitted admitted) throws IOException {
        var headers=response.getHeaders(); var media=headers.getContentType();
        if(response.getStatusCode().value()!=503||media==null||!media.getType().equalsIgnoreCase("application")||!media.getSubtype().equalsIgnoreCase("json")||
            (media.getCharset()!=null&&!media.getCharset().equals(StandardCharsets.UTF_8))||headers.containsKey(HttpHeaders.CONTENT_ENCODING)||
            !List.of("no-store").equals(headers.get(HttpHeaders.CACHE_CONTROL))) throw new IOException("Unverified KAG error");
        byte[] bytes=response.getBody().readNBytes(256*1024+1);
        if(bytes.length>256*1024) throw new IOException("KAG response too large");
        var body=parse(StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString(),admitted.token());
        if(!fields(body).equals(Set.of("request_id","error","native_state"))||!fields(body.path("error")).equals(Set.of("code","message","retryable"))||
            !body.path("error").path("code").isTextual()||!body.path("error").path("code").asText().equals("KAG_ABSTAINED")||
            !text(body.path("error").path("message"),4000,true)||!body.path("error").path("retryable").isBoolean()||body.path("error").path("retryable").asBoolean()||
            !body.path("native_state").isTextual()||!body.path("native_state").asText().equals("abstained")||!text(body.path("request_id"),36,true)) throw new IOException("Unverified KAG abstention");
        String id=body.path("request_id").asText();
        if(!UUID.fromString(id).toString().equals(id)) throw new IOException("Invalid request identity");
        echo(headers,"X-Request-ID",id);
        // Native errors have no success identity echoes; reject mismatches when echoes are present.
        for(var pin:Map.of("X-KAG-Release-ID",admitted.pins().release(),admitted.pins().sourceHeader(),admitted.pins().snapshot(),"X-KAG-As-Of",admitted.date().toString()).entrySet())
            if(headers.containsKey(pin.getKey())) echo(headers,pin.getKey(),pin.getValue());
        currentDate(admitted.date()); return json.createObjectNode().put("state","KAG_ABSTAINED");
    }
    private Admitted admit(Object request) throws IOException {
        currentDate(LocalDate.now(clock));
        if(!(request instanceof Map<?,?> input)||!input.keySet().equals(REQUEST_FIELDS)||!(input.get("user_id") instanceof UUID owner)) throw new IOException("Invalid request");
        var body=json.valueToTree(request);
        if(!fields(body).equals(REQUEST_FIELDS)||!body.path("user_id").isTextual()||!owner.toString().equals(body.path("user_id").asText())||
            !text(body.path("message"),4000,true)||!body.path("context_id").isTextual()||!body.path("context_id").asText().isEmpty()||
            !body.path("schema_contract").equals(json.valueToTree(schema.identity()))) throw new IOException("Invalid request");
        var pins=activePins();headerIdentity(pins.snapshot());
        ((com.fasterxml.jackson.databind.node.ObjectNode)body).set("schema_contract",pins.schema());
        byte[] bytes=json.writeValueAsBytes(body);
        if(bytes.length>64*1024) throw new IOException("Request too large");
        return new Admitted(bytes,readToken(tokenFile),LocalDate.now(clock),pins);
    }
    private static String readToken(String credentialFile) throws IOException {
        if(credentialFile.isBlank()) throw new IOException("Credentials unavailable");
        Path path=Path.of(credentialFile);
        if(!Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS)||!Files.isReadable(path)) throw new IOException("Credentials unavailable");
        byte[] secret;
        try(var file=Files.newInputStream(path,LinkOption.NOFOLLOW_LINKS)) { secret=file.readNBytes(515); }
        if(secret.length>514) throw new IOException("Credentials unavailable");
        int length=secret.length;
        if(length>0&&secret[length-1]=='\n') {
            length--; if(length>0&&secret[length-1]=='\r') length--;
        }
        String token=StandardCharsets.US_ASCII.newDecoder().decode(ByteBuffer.wrap(secret,0,length)).toString();
        if(token.length()<43||token.length()>512||!token.matches("[A-Za-z0-9._~+/-]+=*")) throw new IOException("Credentials unavailable");
        return token;
    }
    private RestClient.RequestBodySpec post(String path,Admitted admitted) {
        currentDate(admitted.date());
        return client.post().uri(path).contentType(MediaType.APPLICATION_JSON).header(HttpHeaders.AUTHORIZATION,"Bearer "+admitted.token())
            .header("X-KAG-Release-ID",admitted.pins().release()).header(admitted.pins().sourceHeader(),admitted.pins().snapshot()).header("X-KAG-As-Of",admitted.date().toString()).body(admitted.body());
    }
    private void verifyHeaders(HttpHeaders headers,Admitted admitted,MediaType expected) throws IOException {
        LocalDate date=admitted.date();
        echo(headers,"X-KAG-Release-ID",admitted.pins().release()); echo(headers,admitted.pins().sourceHeader(),admitted.pins().snapshot()); echo(headers,"X-KAG-As-Of",date.toString());
        var type=headers.getContentType();
        if(type==null||!expected.getType().equalsIgnoreCase(type.getType())||!expected.getSubtype().equalsIgnoreCase(type.getSubtype())||
            (type.getCharset()!=null&&!type.getCharset().equals(StandardCharsets.UTF_8))||headers.containsKey(HttpHeaders.CONTENT_ENCODING)) throw new IOException("Invalid response media");
        currentDate(date);
    }
    private static void echo(HttpHeaders headers,String name,String expected) throws IOException {
        var values=headers.get(name);
        if(values==null||values.size()!=1||!expected.equals(values.getFirst())) throw new IOException("Invalid identity echo");
    }
    private static void headerIdentity(String value) throws IOException {
        if(value.isBlank()||value.length()>512||!value.equals(value.strip())||value.chars().anyMatch(c->c<32||c>126)) throw new IOException("Identity unavailable");
    }
    private void currentDate(LocalDate expected) {
        if(!ZoneId.systemDefault().getRules().equals(LEGAL_ZONE.getRules())||!clock.getZone().getRules().equals(LEGAL_ZONE.getRules())||!expected.equals(LocalDate.now(clock))) throw unavailable();
    }
    private JsonNode parse(String value,String token) throws IOException {
        JsonNode result=json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(value);
        if(result!=null&&result.toString().contains(token)) throw new IOException("Credentials reflected");
        return result;
    }
    private static Set<String> fields(JsonNode value) {
        var fields=new HashSet<String>(); if(value!=null&&value.isObject()) value.fieldNames().forEachRemaining(fields::add); return fields;
    }
    private static boolean text(JsonNode node,int max,boolean nonblank) {
        if(!node.isTextual()) return false;
        String value=node.asText();
        if(value.length()>max||(nonblank&&value.isBlank())) return false;
        for(int i=0;i<value.length();i++) {
            char c=value.charAt(i);
            if(Character.isHighSurrogate(c)) { if(++i==value.length()||!Character.isLowSurrogate(value.charAt(i))) return false; }
            else if(Character.isLowSurrogate(c)) return false;
        }
        return true;
    }
    private void validateResult(JsonNode result,Admitted admitted) throws IOException {
        if(!admitted.pins().dataset()) {validateResult(result);return;}
        if(!fields(result).equals(Set.of("contract_version","answer","citations"))||!result.path("contract_version").asText().equals("graph-chat-v1")||
            !text(result.path("answer"),20000,true)||!result.path("citations").isArray()||result.path("citations").isEmpty()||result.path("citations").size()>20)throw new IOException("Invalid graph answer");
        var expectedFields=new HashSet<>(CITATION_FIELDS);expectedFields.add("source");
        for(var citation:result.path("citations")) {
            var source=citation.path("source");var pins=admitted.pins();var metadata=source.path("metadata");
            if(!fields(citation).equals(expectedFields)||!fields(source).equals(Set.of("contract_version","release_id","source_snapshot_id","release_descriptor_sha256","schema_contract","entity_type","entity_id","source_sha256","text","metadata","document_metadata","as_of"))||
                !source.path("contract_version").asText().equals("graph-source-v1")||!source.path("release_id").asText().equals(pins.release())||
                !source.path("source_snapshot_id").asText().equals(pins.snapshot())||!source.path("release_descriptor_sha256").asText().equals(pins.descriptor())||
                !source.path("schema_contract").equals(pins.schema())||!source.path("as_of").asText().equals(admitted.date().toString())||
                !text(citation.path("doc_id"),256*1024,true)||!text(citation.path("quote"),20000,true)||!source.path("text").equals(citation.path("quote"))||
                !metadata.isObject()||!source.path("document_metadata").isObject()||!source.path("document_metadata").path("id").equals(citation.path("doc_id"))||
                !bounded(citation.path("start"),0,0)||!bounded(citation.path("end"),1,20000)||
                citation.path("end").asInt()!=citation.path("quote").asText().codePointCount(0,citation.path("quote").asText().length()))throw new IOException("Invalid graph source binding");
            String type=source.path("entity_type").asText(),prefix=pins.schema().path("namespace").asText()+".";
            String kind=type.startsWith(prefix)?type.substring(prefix.length()):"";
            String identity=switch(kind) {case "LegalDocument"->"doc_id";case "LegalUnit"->"unit_id";case "TrafficSign"->"sign_id";default->throw new IOException("Invalid source type");};
            for(String field:List.of("unit_id","sign_id"))if(!citation.path(field).isNull()&&!text(citation.path(field),256*1024,true))throw new IOException("Invalid source identity");
            if(!text(source.path("entity_id"),256*1024,true)||!source.path("entity_id").equals(citation.path(identity))||!metadata.path("id").equals(source.path("entity_id"))||
                !kind.equals("LegalDocument")&&!metadata.path("doc_id").equals(citation.path("doc_id"))||
                kind.equals("LegalDocument")&&(!citation.path("unit_id").isNull()||!citation.path("sign_id").isNull())||
                kind.equals("LegalUnit")&&!citation.path("sign_id").isNull()||
                kind.equals("TrafficSign")&&!metadata.path("unit_id").asText("").equals(citation.path("unit_id").asText("")))throw new IOException("Source identity mismatch");
            String field=citation.path("field").asText();boolean matches=false;
            for(var property:schema.contract().path("node_properties").path(kind))
                if((property.path("logical_name").asText().equals(field)||property.path("schema_name").asText().equals(field))&&metadata.path(property.path("logical_name").asText()).equals(source.path("text")))matches=true;
            if(!matches||!source.path("source_sha256").asText().equals(sha256(source.path("text").asText().getBytes(StandardCharsets.UTF_8)))||
                !citation.path("evidence_id").asText().equals(sha256(json.writeValueAsBytes(List.of(type,source.path("entity_id").asText(),field)))))throw new IOException("Source quote mismatch");
        }
    }
    private static String sha256(byte[] value) throws IOException {
        try {return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(value));}
        catch(java.security.NoSuchAlgorithmException e){throw new IOException(e);}
    }
    private static void validateResult(JsonNode result) throws IOException {
        if(!fields(result).equals(Set.of("answer","citations"))||!text(result.path("answer"),20000,true)||!result.path("citations").isArray()||
            result.path("citations").isEmpty()||result.path("citations").size()>20) throw new IOException("Invalid result");
        for(var c:result.path("citations")) {
            if(!fields(c).equals(CITATION_FIELDS)||!text(c.path("doc_id"),256*1024,true)||!text(c.path("unit_id"),256*1024,true)||!c.path("sign_id").isNull()||
                !c.path("evidence_id").isTextual()||!c.path("evidence_id").asText().matches("[0-9a-f]{64}")||!c.path("field").asText().equals("text")||
                !text(c.path("quote"),20000,true)||!c.path("start").isIntegralNumber()||!c.path("start").canConvertToInt()||c.path("start").intValue()!=0||
                !c.path("end").isIntegralNumber()||!c.path("end").canConvertToInt()||c.path("end").intValue()!=c.path("quote").asText().codePointCount(0,c.path("quote").asText().length())) throw new IOException("Invalid citation structure");
        }
    }
    private static ResponseStatusException unavailable() { return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Dịch vụ KAG chưa khả dụng"); }
    private static class LimitedInput extends FilterInputStream {
        int total;
        LimitedInput(InputStream input) { super(input); }
        private void count(int n) throws IOException { if(n>0 && (total+=n)>256*1024) throw new IOException("Stream too large"); }
        @Override public int read() throws IOException { int n=super.read(); count(n<0?0:1); return n; }
        @Override public int read(byte[] b,int off,int len) throws IOException { int n=super.read(b,off,len); count(n); return n; }
    }
}
