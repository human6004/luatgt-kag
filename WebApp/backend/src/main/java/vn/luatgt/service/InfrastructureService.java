package vn.luatgt.service;
import vn.luatgt.integration.ObjectStorage;
import vn.luatgt.integration.KagClient;
import vn.luatgt.dto.KagRetrieveRequest;
import vn.luatgt.dto.ChatRetrievalChangeRequest;
import com.fasterxml.jackson.databind.JsonNode;
import javax.sql.DataSource;
import java.util.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
@Service
public class InfrastructureService {
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(InfrastructureService.class);
    private final DataSource database; private final StringRedisTemplate redis; private final ObjectStorage storage; private final KagClient kag;
    public InfrastructureService(DataSource database,StringRedisTemplate redis,ObjectStorage storage,KagClient kag) { this.database=database; this.redis=redis; this.storage=storage; this.kag=kag; }
    public Map<String,Object> kagStatus() { return kag.status(); }
    public JsonNode kagConfiguration() { return kag.configuration(); }
    public JsonNode llmCredentials(vn.luatgt.dto.LLMCredentialsChangeRequest change) {
        var result=kag.llmCredentials(change);
        if(change!=null)LOG.info("Model config actor={} action=save revision={} chat={} embedding={}",
            configActor(),result.path("revision").asInt(),change.chat()!=null,change.embedding()!=null);
        return result;
    }
    public JsonNode modelAction(String role,String action,vn.luatgt.dto.ModelConfigActionRequest change) {
        var result=kag.modelAction(role,action,change);var row=result.path("roles").path(role);
        LOG.info("Model config actor={} action={} role={} revision={} result={} code={}",configActor(),action,role,
            row.path("saved_revision").asInt(),action.equals("test")?row.path("test").path("status").asText():row.path("status").asText(),
            action.equals("test")?row.path("test").path("code").asText():row.path("blocker").asText());
        return result;
    }
    private String configActor() {
        var auth=org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
        return auth!=null&&auth.getName().matches("[0-9a-f-]{36}")?auth.getName():"service";
    }
    public JsonNode chatRetrievalConfiguration() { return kag.chatRetrieval(null,null); }
    public JsonNode changeChatRetrieval(String action,ChatRetrievalChangeRequest request) { return kag.chatRetrieval(action,request); }
    public JsonNode pipelineStatus() { return kag.pipelineStatus(); }
    public JsonNode builderStatus() { return kag.builderStatus(); }
    public JsonNode builderInputs() { return kag.builderInputs(); }
    public JsonNode dataset(String group,int offset,int limit) {return kag.builderDataset(group,offset,limit);}
    public JsonNode checkBuilderInputs() { return kag.checkBuilderInputs(); }
    public JsonNode builderConfiguration() { return kag.builderConfiguration(); }
    public JsonNode builderProjects() { return kag.builderProjects(); }
    public JsonNode graphProject(int projectId) { return kag.graphProject(projectId); }
    public JsonNode graphSources(int projectId,String runId) {return legalUnits.sourceComparison(kag.builderSources(projectId,runId));}
    @org.springframework.beans.factory.annotation.Autowired private LegalUnitService legalUnits;
    public JsonNode serving() {return kag.serving(null,null,null);}
    public JsonNode servingAction(String action,JsonNode change) {return kag.serving(action,change,null);}
    public JsonNode builderStructure(String action,JsonNode change) { return kag.builderStructure(action,change); }
    public JsonNode saveBuilderConfiguration(JsonNode change) { return kag.saveBuilderConfiguration(change); }
    public JsonNode previewBuilderSelection(JsonNode change) { return kag.previewBuilderSelection(change); }
    public JsonNode builderClear(String action,JsonNode change) { return kag.builderClear(action,change); }
    public JsonNode checkBuilderReadiness() { return kag.checkBuilderReadiness(); }
    public JsonNode builderAction(String action,String runId) { return kag.builderAction(action,runId); }
    public JsonNode builderAction(String action,String runId,String revision) { return kag.builderAction(action,runId,revision); }
    public JsonNode benchmarkDatasets() { return kag.benchmarkDatasets(); }
    public JsonNode sampleInspection() { return kag.sampleInspection(); }
    public JsonNode retrieve(KagRetrieveRequest request) { return kag.retrieve(request.message(),request.top_k(),request.expand()); }
    public JsonNode trialGraph(int projectId,String runId,KagRetrieveRequest request) {return kag.trialGraph(projectId,runId,request);}
    public Map<String,String> status() {
        var result=new LinkedHashMap<String,String>();
        try(var connection=database.getConnection()) { result.put("MySQL",connection.isValid(2)?"UP":"DOWN"); } catch(Exception e) { result.put("MySQL","DOWN"); }
        try(var connection=Objects.requireNonNull(redis.getConnectionFactory()).getConnection()) { result.put("Redis","PONG".equals(connection.ping())?"UP":"DOWN"); } catch(Exception e) { result.put("Redis","DOWN"); }
        result.put("MinIO",storage.available()?"UP":"DOWN"); return result;
    }
}
