package vn.luatgt;

import vn.luatgt.model.*;
import vn.luatgt.repository.*;
import vn.luatgt.service.RateLimit;
import vn.luatgt.integration.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.time.Instant;
import java.util.*;
import java.io.*;
import java.nio.file.Path;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.*;
import org.springframework.http.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.test.context.transaction.TestTransaction;
import vn.luatgt.service.ChatService;
import vn.luatgt.dto.ChatRequest;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@SpringBootTest @AutoConfigureMockMvc
class CoreTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired ContentRepository contents;
    @Autowired ExamRepository exams;
    @Autowired LearningCatalogRepository catalog;
    @Autowired SignCatalogRepository signCatalog;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired ContentHistoryRepository history;
    @Autowired LawRelationRepository relations;
    @Autowired PenaltyRepository penalties;
    @Autowired LegalUnitRepository legalUnits;
    @Autowired ChatRepository chats;
    @Autowired AccountRepository accounts;
    @Autowired ChatService chat;
    @TempDir Path streamTemporary;
    @MockitoBean RateLimit rate;
    @MockitoBean KagClient kag;
    @MockitoBean ObjectStorage storage;
    String admin;
    @Test void chatStreamDeclaresEventStreamContentType() throws Exception {
        String user=register();
        mvc.perform(post("/api/chat").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON)
            .content("{\"message\":\"Nguồn thử?\"}")).andExpect(status().isMethodNotAllowed());
        verifyNoInteractions(kag);
        var result=mvc.perform(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user)
            .contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Nguồn thử?\"}"))
            .andExpect(request().asyncStarted()).andReturn();
        mvc.perform(asyncDispatch(result)).andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM));
    }
    @Test void builderSourceCheckRequiresAdminAndRejectsClientInputs() throws Exception {
        mvc.perform(post("/api/admin/kag/builder/inputs")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/admin/kag/builder/inputs").header("Authorization","Bearer "+register())).andExpect(status().isForbidden());
        when(kag.checkBuilderInputs()).thenReturn(json.createObjectNode().put("fixture","CHECKING"));
        mvc.perform(post("/api/admin/kag/builder/inputs").header("Authorization","Bearer "+admin)).andExpect(status().isAccepted()).andExpect(header().string("Cache-Control","no-store"));
        verify(kag).checkBuilderInputs();clearInvocations(kag);
        mvc.perform(post("/api/admin/kag/builder/inputs?path=/tmp/other").header("Authorization","Bearer "+admin)).andExpect(status().isBadRequest());
        mvc.perform(post("/api/admin/kag/builder/inputs").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isBadRequest());
        mvc.perform(post("/api/admin/kag/builder/inputs").header("Authorization","Bearer "+admin).header("Transfer-Encoding","chunked")).andExpect(status().isBadRequest());
        verifyNoInteractions(kag);
    }
    @BeforeEach void admin() throws Exception { admin=token("admin@test.vn","TEST-only-admin-password"); }
    @Test void builderConfigurationAndReadinessRequireAdminAndRejectNetworkParameters() throws Exception {
        String user=register();
        for(String path:List.of("configuration","preflight")) {
            mvc.perform(post("/api/admin/kag/builder/"+path).contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isUnauthorized());
            mvc.perform(post("/api/admin/kag/builder/"+path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isForbidden());
        }
        var metadata=json.createObjectNode().put("fixture","CONFIGURATION");
        when(kag.builderConfiguration()).thenReturn(metadata);when(kag.checkBuilderReadiness()).thenReturn(metadata);
        mvc.perform(get("/api/admin/kag/builder/configuration").header("Authorization","Bearer "+admin))
            .andExpect(status().isOk()).andExpect(header().string("Cache-Control","no-store"));
        mvc.perform(post("/api/admin/kag/builder/preflight").header("Authorization","Bearer "+admin))
            .andExpect(status().isAccepted()).andExpect(header().string("Cache-Control","no-store"));
        clearInvocations(kag);
        mvc.perform(get("/api/admin/kag/builder/configuration?target=http://localhost").header("Authorization","Bearer "+admin)).andExpect(status().isBadRequest());
        mvc.perform(post("/api/admin/kag/builder/preflight").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isBadRequest());
        verifyNoInteractions(kag);
    }
    String token(String email,String password) throws Exception {
        return body(mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("email",email,"password",password)))).andExpect(status().isOk()).andReturn()).path("accessToken").asText();
    }
    String register() throws Exception {
        return body(mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("email",UUID.randomUUID()+"@test.vn","password","TEST-only-user-password","name","Học viên")))).andExpect(status().isOk()).andExpect(jsonPath("$.user.role").value("USER")).andReturn()).path("accessToken").asText();
    }
    JsonNode body(MvcResult result) throws Exception { return json.readTree(result.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8)); }
    JsonNode progressResponse(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request,String event) throws Exception {
        var pending=mvc.perform(request).andExpect(request().asyncStarted()).andReturn();
        var result=mvc.perform(asyncDispatch(pending)).andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM)).andReturn();
        return terminal(result.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8),event);
    }
    JsonNode terminal(String stream,String event) throws Exception {
        assertTrue(stream.startsWith("event: started\n")); assertFalse(stream.contains("event: delta\n"));
        String marker="event: "+event+"\ndata: "; int start=stream.indexOf(marker); assertTrue(start>=0,stream);
        return json.readTree(stream.substring(start+marker.length()).split("\n\n",2)[0]);
    }
    @Test void authCannotEscalateAndLogoutRevokesToken() throws Exception {
        for(String role:List.of("ADMIN","POLICE")) mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("email","attacker@test.vn","name","User","password","TEST-only-user-password","role",role)))).andExpect(status().isBadRequest());
        String user=register();
        mvc.perform(get("/api/admin/users").header("Authorization","Bearer "+user)).andExpect(status().isForbidden());
        mvc.perform(post("/api/auth/logout").header("Authorization","Bearer "+user)).andExpect(status().isOk());
        mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/questions")).andExpect(status().isUnauthorized());
    }
    @Test void policeManagesContentAndChatWithoutSystemOrAccountAccess() throws Exception {
        String user=register();
        var profile=body(mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andReturn());
        String id=profile.path("id").asText(), email=profile.path("email").asText();
        mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"POLICE\"}")).andExpect(status().isOk());
        mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andExpect(status().isUnauthorized());
        String police=token(email,"TEST-only-user-password");
        mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+police)).andExpect(jsonPath("$.role").value("POLICE"));
        for(String path:List.of("questions","signs","documents","units","law-relations","chatlogs","penalties"))
            mvc.perform(get("/api/admin/"+path).header("Authorization","Bearer "+police)).andExpect(status().isOk());
        var question=new Content(); question.kind="questions"; question.externalId="POLICE-"+UUID.randomUUID();
        question.data=json.writeValueAsString(Map.of("externalId",question.externalId,"text","Câu hỏi kiểm duyệt","chapter",1,"options",List.of("A","B")));
        question=contents.saveAndFlush(question);
        mvc.perform(put("/api/admin/content/"+question.id).header("Authorization","Bearer "+police).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("version",question.version,"data",json.readTree(question.data))))).andExpect(status().isOk());
        when(storage.get("police-draft-image")).thenReturn(new byte[]{1,2,3});
        var draft=new Content(); draft.kind="signs"; draft.externalId="DRAFT-"+UUID.randomUUID(); draft.data="{\"imageKey\":\"police-draft-image\",\"imageMime\":\"image/png\"}"; draft=contents.saveAndFlush(draft);
        mvc.perform(get("/api/content/"+draft.id+"/media").header("Authorization","Bearer "+police)).andExpect(status().isOk()).andExpect(content().bytes(new byte[]{1,2,3}));
        var message=new ChatMessage(); message.ownerId=UUID.fromString(id); message.question="Kiểm tra nội dung"; message.state="UNAVAILABLE"; message.feedback="WRONG"; message=chats.saveAndFlush(message);
        mvc.perform(post("/api/admin/chatlogs/"+message.id+"/resolve").header("Authorization","Bearer "+police).contentType(MediaType.APPLICATION_JSON).content("{\"note\":\"Đã kiểm tra\"}")).andExpect(status().isOk());
        assertTrue(chats.findById(message.id).orElseThrow().resolved);
        for(String path:List.of("users","infrastructure","kag/status","kag/schema","kag/config","kag/config/models","kag/config/retrieval","kag/builder/status"))
            mvc.perform(get("/api/admin/"+path).header("Authorization","Bearer "+police)).andExpect(status().isForbidden());
        mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+police).contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"ADMIN\"}")).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/kag/builder/build").header("Authorization","Bearer "+police).contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/kag/builder/inputs").header("Authorization","Bearer "+police)).andExpect(status().isForbidden());
        mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"USER\"}")).andExpect(status().isOk());
        mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+police)).andExpect(status().isUnauthorized());
        String demoted=token(email,"TEST-only-user-password");
        mvc.perform(get("/api/admin/questions").header("Authorization","Bearer "+demoted)).andExpect(status().isForbidden());
        mvc.perform(get("/api/content/"+draft.id+"/media").header("Authorization","Bearer "+demoted)).andExpect(status().isNotFound());
    }
    @Test void roleChangesAreAdminOnlyValidatedAndPreserveAdminProtection() throws Exception {
        String user=register();
        String id=body(mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andReturn()).path("id").asText();
        mvc.perform(patch("/api/admin/users/"+id).contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"POLICE\"}")).andExpect(status().isUnauthorized());
        mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"POLICE\"}")).andExpect(status().isForbidden());
        for(String role:List.of("EDITOR","ADMIN","police",""))
            mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("role",role)))).andExpect(status().isBadRequest());
        mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isBadRequest());
        String adminId=accounts.findByEmail("admin@test.vn").orElseThrow().id.toString();
        mvc.perform(patch("/api/admin/users/"+adminId).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"role\":\"POLICE\",\"enabled\":false}")).andExpect(status().isBadRequest());
        mvc.perform(patch("/api/admin/users/"+id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"enabled\":false}")).andExpect(status().isOk());
        mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andExpect(status().isUnauthorized());
    }
    @Test void roleMigrationPreservesAccountsAndKeepsDatabaseValidation() throws Exception {
        String url="jdbc:h2:mem:role_upgrade_"+UUID.randomUUID()+";MODE=MySQL";
        try(var connection=java.sql.DriverManager.getConnection(url,"sa","")) {
            org.flywaydb.core.Flyway.configure().dataSource(url,"sa","").target("3").load().migrate();
            try(var insert=connection.prepareStatement("INSERT INTO accounts(id,email,password,name,role,enabled,token_version) VALUES (?,?,'existing-hash','Giữ nguyên',?,FALSE,7)")) {
                for(int i=0;i<2;i++) { byte[] id=new byte[16]; id[15]=(byte)i; insert.setBytes(1,id); insert.setString(2,i+"@upgrade.test"); insert.setString(3,i==0?"USER":"ADMIN"); insert.executeUpdate(); }
            }
            org.flywaydb.core.Flyway.configure().dataSource(url,"sa","").load().migrate();
            try(var statement=connection.createStatement();var rows=statement.executeQuery("SELECT password,name,role,enabled,token_version FROM accounts ORDER BY email")) {
                for(String role:List.of("USER","ADMIN")) { assertTrue(rows.next()); assertEquals("existing-hash",rows.getString(1)); assertEquals("Giữ nguyên",rows.getString(2)); assertEquals(role,rows.getString(3)); assertFalse(rows.getBoolean(4)); assertEquals(7,rows.getInt(5)); }
                assertFalse(rows.next());
            }
            try(var statement=connection.createStatement()) {
                assertEquals(1,statement.executeUpdate("UPDATE accounts SET role='POLICE' WHERE email='0@upgrade.test'"));
                assertThrows(java.sql.SQLException.class,()->statement.executeUpdate("UPDATE accounts SET role='EDITOR' WHERE email='0@upgrade.test'"));
            }
        }
    }
    @Test void kagInspectionIsAdminOnlyAndUsesExistingServiceAdapter() throws Exception {
        String user=register();
        mvc.perform(get("/api/admin/kag/status").header("Authorization","Bearer "+user)).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/kag/retrieve").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Nguồn thử\",\"top_k\":3,\"expand\":false}")).andExpect(status().isForbidden());
        verify(kag,never()).status();verify(kag,never()).retrieve(anyString(),anyInt(),anyBoolean());
        when(kag.status()).thenReturn(Map.of("liveness",Map.of("state","ALIVE","httpStatus",200),"queryReadiness",Map.of("state","NOT_READY","httpStatus",503)));
        mvc.perform(get("/api/admin/kag/status").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.liveness.state").value("ALIVE")).andExpect(jsonPath("$.queryReadiness.state").value("NOT_READY"));
        when(kag.retrieve("Nguồn thử",3,false)).thenReturn(json.readTree("{\"items\":[]}"));
        mvc.perform(post("/api/admin/kag/retrieve").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Nguồn thử\",\"top_k\":3,\"expand\":false}")).andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty());
        verify(kag).retrieve("Nguồn thử",3,false);
    }
    @Test void kagRuntimeInspectionIsReadOnlyAndAdminOnly() throws Exception {
        String user=register();
        for(String path:List.of("/api/admin/kag/pipeline","/api/admin/kag/benchmark/datasets","/api/admin/kag/sample")) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
            mvc.perform(get(path).header("Authorization","Bearer "+user)).andExpect(status().isForbidden());
        }
        verify(kag,never()).pipelineStatus();verify(kag,never()).benchmarkDatasets();
        when(kag.pipelineStatus()).thenReturn(json.readTree("{\"phase\":\"idle\",\"execution_allowed\":false}"));
        when(kag.benchmarkDatasets()).thenReturn(json.readTree("{\"state\":\"NOT_CONFIGURED\",\"datasets\":[]}"));
        mvc.perform(get("/api/admin/kag/pipeline").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.execution_allowed").value(false));
        mvc.perform(get("/api/admin/kag/benchmark/datasets").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.datasets").isEmpty());
        mvc.perform(post("/api/admin/kag/pipeline").header("Authorization","Bearer "+admin)).andExpect(status().isMethodNotAllowed());
        when(kag.sampleInspection()).thenReturn(json.readTree("{\"release_kind\":\"SAMPLE\",\"execution_allowed\":false}"));
        mvc.perform(get("/api/admin/kag/sample").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.release_kind").value("SAMPLE"));
        mvc.perform(get("/api/admin/kag/sample?cypher=MATCH").header("Authorization","Bearer "+admin)).andExpect(status().isBadRequest());
        mvc.perform(post("/api/admin/kag/sample").header("Authorization","Bearer "+admin)).andExpect(status().isMethodNotAllowed());
    }
    @ParameterizedTest @ValueSource(strings={"{\"message\":\"Nguồn thử\",\"top_k\":0,\"expand\":false}","{\"message\":\"Nguồn thử\",\"top_k\":11,\"expand\":false}","{\"message\":\"Nguồn thử\",\"top_k\":1.5,\"expand\":false}","{\"message\":\"Nguồn thử\",\"top_k\":1,\"expand\":\"true\"}","{\"message\":\"Nguồn thử\",\"top_k\":1}","{\"message\":\"Nguồn thử\",\"top_k\":1,\"expand\":false,\"schema_contract\":{}}"})
    void kagAdminInputRejectsCoercionAndForgedSchema(String body) throws Exception {
        mvc.perform(post("/api/admin/kag/retrieve").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isBadRequest());
        verify(kag,never()).retrieve(anyString(),anyInt(),anyBoolean());
    }
    @Test void importsAreAtomicDraftsAndPreserveLegalMetadata() throws Exception {
        String rows="{\"rows\":[{\"sign_id\":\"QCVN 41:2024/BGTVT::DP.127\",\"ma_bien\":\"DP.127\",\"ten\":\"Biển hết tốc độ tối đa\",\"nhom\":\"Biển hết cấm\",\"doc_id\":\"51_2024_TT_BGTVT\",\"mo_ta\":\"Cần kiểm tra nội dung đầy đủ\",\"qcvn\":\"QCVN 41:2024/BGTVT\",\"so_hieu\":\"51/2024/TT-BGTVT\",\"unit_id\":\"D84\",\"ngay_hieu_luc\":\"2025-01-01\",\"ngay_het_hieu_luc\":null}]}";
        mvc.perform(post("/api/admin/imports/signs/confirm").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(rows)).andExpect(status().isOk()).andExpect(jsonPath("$.inserted").value(1));
        var sign=contents.findByKindAndExternalId("signs","QCVN 41:2024/BGTVT::DP.127").orElseThrow();
        assertFalse(sign.published); assertEquals("51_2024_TT_BGTVT",json.readTree(sign.data).path("doc_id").asText());
        mvc.perform(post("/api/admin/content/"+sign.id+"/publication").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"version\":0,\"published\":true}")).andExpect(status().isBadRequest());
        long count=contents.count();
        mvc.perform(post("/api/admin/imports/questions/confirm").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"rows\":[{\"externalId\":\"valid-first\",\"text\":\"Câu hỏi\",\"chapter\":1,\"options\":[\"A\",\"B\"]},{\"externalId\":\"invalid\"}]}")).andExpect(status().isBadRequest());
        assertEquals(count,contents.count());
    }
    @Test void providedPdfDraftsAreAcceptedForPreviewButNotPublished() throws Exception {
        long count=contents.count();
        for(int size:List.of(250,600)) {
            var rows=json.readTree(java.nio.file.Files.readString(java.nio.file.Path.of("../docs/"+size+"/questions-draft.json")));
            assertEquals(size,rows.size());
            var result=body(mvc.perform(post("/api/admin/imports/questions/preview").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",rows)))).andExpect(status().isOk()).andReturn());
            assertEquals(size,result.size());for(var row:result)assertTrue(row.path("valid").asBoolean(),row.toString());
        }
        assertEquals(count,contents.count());
    }
    @Test void zipMatchesCodeAndRejectsTraversal() throws Exception {
        var sign=new Content(); sign.kind="signs"; sign.externalId="ZIP-TEST"; sign.data="{\"externalId\":\"ZIP-TEST\",\"code\":\"DP.127\",\"name\":\"Biển thử\",\"group\":\"Biển hết cấm\"}"; contents.save(sign);
        // Remove another sign with the same code so the archive has an unambiguous match.
        for(var c:contents.findByKindOrderByExternalId("signs")) if(!c.id.equals(sign.id)) {jdbc.update("DELETE FROM signs WHERE content_id=?",LearningCatalogRepository.binary(c.id));contents.delete(c);}
        var png=new java.io.ByteArrayOutputStream(); javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(10,10,java.awt.image.BufferedImage.TYPE_INT_RGB),"png",png);
        var archive=new java.io.ByteArrayOutputStream();
        try(var zip=new java.util.zip.ZipOutputStream(archive)) { zip.putNextEntry(new java.util.zip.ZipEntry("DP.127.png")); zip.write(png.toByteArray()); zip.closeEntry(); }
        when(storage.put(any(),eq("image/png"))).thenReturn("test-image-key");
        mvc.perform(multipart("/api/admin/signs/images-zip").file(new org.springframework.mock.web.MockMultipartFile("file","images.zip","application/zip",archive.toByteArray())).header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.matched[0]").value("DP.127"));
        var saved=contents.findById(sign.id).orElseThrow(); assertFalse(saved.published); assertEquals("test-image-key",json.readTree(saved.data).path("imageKey").asText());
        var bad=new java.io.ByteArrayOutputStream();
        try(var zip=new java.util.zip.ZipOutputStream(bad)) { zip.putNextEntry(new java.util.zip.ZipEntry("../DP.127.png")); zip.write(png.toByteArray()); zip.closeEntry(); }
        mvc.perform(multipart("/api/admin/signs/images-zip").file(new org.springframework.mock.web.MockMultipartFile("file","bad.zip","application/zip",bad.toByteArray())).header("Authorization","Bearer "+admin)).andExpect(status().isBadRequest());
    }
    void bank() throws Exception {
        penalties.deleteAllInBatch(); relations.deleteAllInBatch(); history.deleteAllInBatch();
        jdbc.update("DELETE FROM signs");contents.deleteAllInBatch();
        for(int chapter=1;chapter<=6;chapter++) for(int i=0;i<12;i++) {
            var c=new Content(); c.kind="questions"; c.externalId="C"+chapter+"Q"+i; c.published=true;
            c.data=json.writeValueAsString(Map.of("externalId",c.externalId,"text","Câu hỏi "+i,"chapter",chapter,"options",List.of("Đúng","Sai"),"correctAnswer",0,"critical",i==0,"reviewed",true,"source","test","answerCandidates",List.of(0),"imageKey","snapshot-image")); contents.save(c);
        }
    }
    @Test @Transactional void signCatalogKeepsVersionedIdentityAndRejectsCrossVersionParents() throws Exception {
        var rows=json.createArrayNode();
        for(String version:List.of("TEST-v1","TEST-v2")) rows.addObject().put("sign_id",version+"::P.1").put("ma_bien","P.1").put("ten","Test sign").put("nhom","Test group").put("qcvn",version).put("record_type","family").putArray("note").add("test-only");
        mvc.perform(post("/api/admin/imports/signs/confirm").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",rows)))).andExpect(status().isOk()).andExpect(jsonPath("$.inserted").value(2));
        assertEquals(2,jdbc.queryForObject("SELECT COUNT(*) FROM signs WHERE ma_bien='P.1' AND qcvn IN ('TEST-v1','TEST-v2')",Integer.class));
        var missing=json.createObjectNode().put("code","C.1").put("qcvn","TEST-v3").put("parent_code","P.1");
        assertThrows(ResponseStatusException.class,()->signCatalog.validateRelations(missing));
        missing.put("qcvn","TEST-v1");signCatalog.validateRelations(missing);
        missing.put("parent_code","C.1");assertThrows(ResponseStatusException.class,()->signCatalog.validateRelations(missing));
        var invalid=rows.get(0).deepCopy();((ObjectNode)invalid).put("children_codes","wrong type");
        mvc.perform(post("/api/admin/imports/signs/preview").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",List.of(invalid))))).andExpect(status().isOk()).andExpect(jsonPath("$[0].valid").value(false));
    }

    @Test void catalogMigrationBackfillsWithoutChangingLegacyHistory() throws Exception {
        String url="jdbc:h2:mem:migration_"+UUID.randomUUID()+";MODE=MySQL;DB_CLOSE_DELAY=-1";
        org.flywaydb.core.Flyway.configure().dataSource(url,"sa","").target("4").load().migrate();
        var db=new org.springframework.jdbc.core.JdbcTemplate(new org.springframework.jdbc.datasource.DriverManagerDataSource(url,"sa",""));
        UUID owner=UUID.randomUUID(),question=UUID.randomUUID(),exam=UUID.randomUUID(),study=UUID.randomUUID();
        db.update("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)",LearningCatalogRepository.binary(owner),"migration@test.vn","test-only","Test","USER",true,0);
        var q=json.createObjectNode().put("externalId","LEGACY-Q").put("text","Migration test").put("chapter",1).put("critical",true).put("correctAnswer",0).put("source","test-only");q.putArray("options").add("A").add("B");
        db.update("INSERT INTO content VALUES (?,?,?,?,?,?)",LearningCatalogRepository.binary(question),"questions","LEGACY-Q",q.toString(),true,0);
        db.update("INSERT INTO exams(id,owner_id,started_at,expires_at,snapshot,answers) VALUES (?,?,?,?,?,?)",LearningCatalogRepository.binary(exam),LearningCatalogRepository.binary(owner),java.sql.Timestamp.from(Instant.now()),java.sql.Timestamp.from(Instant.now().plusSeconds(60)),"[]","{}");
        db.update("INSERT INTO study_attempts VALUES (?,?,?,?,?,?)",LearningCatalogRepository.binary(study),LearningCatalogRepository.binary(owner),LearningCatalogRepository.binary(question),1,true,java.sql.Timestamp.from(Instant.now()));
        org.flywaydb.core.Flyway.configure().dataSource(url,"sa","").load().migrate();
        assertEquals(q.toString(),db.queryForObject("SELECT data FROM content",String.class));assertEquals(1,db.queryForObject("SELECT COUNT(*) FROM question_revision",Integer.class));assertEquals(1,db.queryForObject("SELECT COUNT(*) FROM set_question",Integer.class));assertEquals(1,db.queryForObject("SELECT COUNT(*) FROM exams",Integer.class));assertEquals(1,db.queryForObject("SELECT COUNT(*) FROM study_attempts",Integer.class));assertEquals(0,db.queryForObject("SELECT COUNT(*) FROM study_attempt",Integer.class));
    }

    @Test @Transactional void scopedQuestionBanksKeepIdsMediaAndStudyRevisionsSeparate() throws Exception {
        String user=register();
        var police=new Account();police.email=UUID.randomUUID()+"@test.vn";police.name="Police";police.role="POLICE";police.password=new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode("TEST-only-user-password");accounts.saveAndFlush(police);
        String officer=token(police.email,"TEST-only-user-password");
        var ids=new ArrayList<String>();
        for(String code:List.of("250","600")) {
            var created=body(mvc.perform(post("/api/admin/questions/sets").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("releaseCode","TEST-"+code,"releaseTitle","Test only","setCode",code,"setName","Test "+code)))).andExpect(status().isOk()).andReturn());
            String set=created.path("id").asText();ids.add(set);
            var question=json.createObjectNode().put("externalId","Q001").put("number",1).put("text","Test "+code).put("chapter",1).put("correctAnswer",0).put("critical",false).put("source","test-only").put("reviewed",true);question.putArray("options").add("A").add("B");
            mvc.perform(post("/api/admin/imports/questions/confirm").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",List.of(question),"questionSetId",set)))).andExpect(status().isOk()).andExpect(jsonPath("$.inserted").value(1));
            var c=contents.findByKindAndExternalId("questions",set+"::Q001").orElseThrow();
            var png=new ByteArrayOutputStream();javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(2,2,java.awt.image.BufferedImage.TYPE_INT_RGB),"png",png);
            var archive=new ByteArrayOutputStream();try(var zip=new java.util.zip.ZipOutputStream(archive)){zip.putNextEntry(new java.util.zip.ZipEntry("Q001.png"));zip.write(png.toByteArray());zip.closeEntry();}
            when(storage.put(any(),eq("image/png"))).thenReturn("test-image-"+code);
            mvc.perform(multipart("/api/admin/questions/images-zip").file(new org.springframework.mock.web.MockMultipartFile("file","images.zip","application/zip",archive.toByteArray())).param("questionSetId",set).header("Authorization","Bearer "+officer)).andExpect(status().isOk()).andExpect(jsonPath("$.matched[0]").value("Q001"));
            c=contents.findById(c.id).orElseThrow();
            mvc.perform(post("/api/admin/questions/publication-batch").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",List.of(Map.of("id",c.id,"version",c.version)),"reviewed",true,"published",true)))).andExpect(status().isOk());
        }
        assertNotEquals(ids.get(0),ids.get(1));
        var first=body(mvc.perform(get("/api/questions").param("questionSetId",ids.getFirst()).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertEquals("test-image-250",first.get(0).path("data").path("imageKey").asText());assertEquals(1,first.size());assertEquals("Test 250",first.get(0).path("data").path("text").asText());assertFalse(first.toString().contains("correctAnswer"));assertFalse(first.toString().contains("optionIds"));
        var multiple=json.createObjectNode().put("externalId","MULTI").put("text","Test").put("chapter",1).put("choiceMode","multiple");multiple.putArray("options").add("A").add("B");
        mvc.perform(post("/api/admin/imports/questions/preview").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",List.of(multiple))))).andExpect(status().isOk()).andExpect(jsonPath("$[0].valid").value(false));
        String question=first.get(0).path("id").asText();
        mvc.perform(post("/api/study/"+question+"/answer").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("selected",0,"questionSetId",ids.getFirst())))).andExpect(status().isOk()).andExpect(jsonPath("$.correct").value(true));
        mvc.perform(post("/api/study/"+question+"/answer").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("selected",0,"questionSetId",ids.get(1))))).andExpect(status().isNotFound());
        var progress=body(mvc.perform(get("/api/progress").param("questionSetId",ids.getFirst()).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());assertEquals(1,progress.get(0).path("practiced").asInt());
        var empty=body(mvc.perform(get("/api/progress").param("questionSetId",ids.get(1)).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());assertEquals(0,empty.get(0).path("practiced").asInt());
        var q0=catalog.questions(UUID.fromString(ids.getFirst())).getFirst();var q1=catalog.questions(UUID.fromString(ids.get(1))).getFirst();
        var rulePayload=json.createObjectNode().put("setId",ids.getFirst()).put("license","A1").put("validFrom","2000-01-01").put("totalQuestions",1).put("durationMinutes",1).put("minimumCorrect",1).put("criticalSlots",0).put("failOnCritical",true);rulePayload.set("quotas",json.valueToTree(new int[]{1,0,0,0,0,0}));
        var rule=body(mvc.perform(post("/api/admin/questions/rules").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(rulePayload.toString())).andExpect(status().isOk()).andReturn());
        mvc.perform(post("/api/admin/questions/rules").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(rulePayload.toString())).andExpect(status().isBadRequest());
        var started=body(mvc.perform(post("/api/exams").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ruleId",rule.path("rule_id").asText())))).andExpect(status().isOk()).andExpect(jsonPath("$.license").value("A1")).andReturn());
        assertEquals(1,started.path("questions").size());assertFalse(started.toString().contains("correctAnswer"));
        mvc.perform(put("/api/exams/"+started.path("id").asText()+"/answers/"+q1.path("questionId").asText()).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"selected\":0}")).andExpect(status().isNotFound());
        mvc.perform(put("/api/exams/"+started.path("id").asText()+"/answers/"+question).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"selected\":0}")).andExpect(status().isOk());
        mvc.perform(post("/api/exams/"+started.path("id").asText()+"/submit").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andExpect(jsonPath("$.passed").value(true));
        String tomorrow=java.time.LocalDate.now().plusDays(1).toString();
        mvc.perform(post("/api/admin/questions/rules/"+rule.path("rule_id").asText()+"/end").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("validTo",tomorrow)))).andExpect(status().isOk());
        rulePayload.put("validFrom",tomorrow);
        mvc.perform(post("/api/admin/questions/rules").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(rulePayload.toString())).andExpect(status().isOk());
        mvc.perform(get("/api/exams/"+started.path("id").asText()).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andExpect(jsonPath("$.score").value(1));
        var wrongOption=LearningCatalogRepository.binary(UUID.fromString(q1.path("optionIds").get(0).asText()));
        assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->jdbc.update("INSERT INTO study_attempt VALUES (?,?,?,?,?,?,?)",LearningCatalogRepository.binary(UUID.randomUUID()),LearningCatalogRepository.binary(UUID.fromString(json.readTree(new String(java.util.Base64.getUrlDecoder().decode(user.split("\\.")[1]),java.nio.charset.StandardCharsets.UTF_8)).path("sub").asText())),LearningCatalogRepository.binary(UUID.fromString(q0.path("set_question_id").asText())),wrongOption,LearningCatalogRepository.binary(UUID.fromString(q0.path("revision_id").asText())),true,java.sql.Timestamp.from(Instant.now())));
        var c=contents.findById(UUID.fromString(question)).orElseThrow();var changed=(ObjectNode)json.readTree(c.data);changed.put("text","Changed after study");
        mvc.perform(put("/api/admin/content/"+c.id).header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("version",c.version,"data",changed)))).andExpect(status().isOk());
        c=contents.findById(c.id).orElseThrow();
        mvc.perform(post("/api/admin/content/"+c.id+"/publication").header("Authorization","Bearer "+officer).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("version",c.version,"published",true)))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/admin/questions/sets").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isForbidden());
    }

    @Test @Transactional void examHasQuotasOwnershipSnapshotAndCriticalFailure() throws Exception {
        // No studies refer to these questions in this test database.
        bank(); String user=register(), other=register();
        var publicQuestions=body(mvc.perform(get("/api/questions").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertFalse(publicQuestions.toString().contains("answerCandidates")); assertFalse(publicQuestions.toString().contains("correctAnswer"));
        var start=body(mvc.perform(post("/api/exams").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertEquals(30,start.path("questions").size()); assertFalse(start.toString().contains("correctAnswer")); assertFalse(start.toString().contains("critical")); assertFalse(start.toString().contains("answerCandidates"));
        UUID id=UUID.fromString(start.path("id").asText()); var questions=json.valueToTree(catalog.attemptQuestions(id));
        assertEquals(1,questions.findValues("critical").stream().filter(JsonNode::asBoolean).count());
        int[] quotas={8,1,1,1,9,9};
        for(int ch=1;ch<=6;ch++) { final int chapter=ch; var stream=new ArrayList<JsonNode>(); questions.forEach(stream::add); assertEquals(quotas[ch-1],stream.stream().filter(q -> q.path("chapter").asInt()==chapter&&!q.path("critical").asBoolean()).count()); }
        mvc.perform(get("/api/exams/"+id).header("Authorization","Bearer "+other)).andExpect(status().isNotFound());
        String mediaPath="/api/exams/"+id+"/questions/"+questions.get(0).path("questionId").asText()+"/media";
        when(storage.get("snapshot-image")).thenReturn(new byte[]{1,2,3});
        mvc.perform(get(mediaPath).header("Authorization","Bearer "+other)).andExpect(status().isNotFound());
        var imageChanged=contents.findById(UUID.fromString(questions.get(0).path("questionId").asText())).orElseThrow();
        var imageData=(ObjectNode)json.readTree(imageChanged.data); imageData.put("imageKey","changed-image"); imageChanged.data=imageData.toString(); contents.save(imageChanged);
        mvc.perform(get(mediaPath).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andExpect(content().bytes(new byte[]{1,2,3}));
        for(var q:questions) mvc.perform(put("/api/exams/"+id+"/answers/"+q.path("questionId").asText()).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"selected\":"+(q.path("critical").asBoolean()?1:0)+"}")).andExpect(status().isOk());
        // Alter the current bank; grading must still use the saved snapshot.
        var changed=contents.findAll().getFirst(); var n=(ObjectNode)json.readTree(changed.data); n.put("correctAnswer",1); changed.data=n.toString(); contents.save(changed);
        var result=body(mvc.perform(post("/api/exams/"+id+"/submit").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertEquals(29,result.path("score").asInt()); assertTrue(result.path("criticalFailed").asBoolean()); assertFalse(result.path("passed").asBoolean());
        mvc.perform(post("/api/exams/"+id+"/submit").header("Authorization","Bearer "+user)).andExpect(jsonPath("$.score").value(29));
        mvc.perform(put("/api/exams/"+id+"/answers/"+questions.get(0).path("questionId").asText()).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"selected\":0}")).andExpect(status().isConflict());
        var passing=body(mvc.perform(post("/api/exams").header("Authorization","Bearer "+user)).andReturn()); UUID passingId=UUID.fromString(passing.path("id").asText());
        int wrong=0;
        for(var q:json.valueToTree(catalog.attemptQuestions(passingId))) {
            int choice=q.path("correctAnswer").asInt();
            if(!q.path("critical").asBoolean()&&wrong<3) { choice=1-choice; wrong++; }
            mvc.perform(put("/api/exams/"+passingId+"/answers/"+q.path("questionId").asText()).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"selected\":"+choice+"}")).andExpect(status().isOk());
        }
        mvc.perform(post("/api/exams/"+passingId+"/submit").header("Authorization","Bearer "+user)).andExpect(jsonPath("$.score").value(27)).andExpect(jsonPath("$.passed").value(true));
        var expiring=body(mvc.perform(post("/api/exams").header("Authorization","Bearer "+user)).andReturn()); UUID expiredId=UUID.fromString(expiring.path("id").asText());
        jdbc.update("UPDATE exam_attempt SET expires_at=? WHERE attempt_id=?",java.sql.Timestamp.from(Instant.now().minusSeconds(1)),LearningCatalogRepository.binary(expiredId));
        mvc.perform(put("/api/exams/"+expiredId+"/answers/"+expiring.path("questions").get(0).path("questionId").asText()).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"selected\":0}")).andExpect(status().isConflict());
        mvc.perform(get("/api/exams/"+expiredId).header("Authorization","Bearer "+user)).andExpect(jsonPath("$.score").value(0));
    }
    @Test void unavailableKagNeverFabricatesAnAnswer() throws Exception {
        when(kag.query(any(),any(UUID.class))).thenThrow(new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Dịch vụ KAG chưa khả dụng")); String user=register();
        assertEquals("UNAVAILABLE",progressResponse(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user)
            .contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Mức phạt là gì?\"}"),"error").path("state").asText());
        mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andExpect(jsonPath("$[0].state").value("UNAVAILABLE")).andExpect(jsonPath("$[0].answer").value(""));
    }
    @Test void unsupportedChatContextRejectedBeforeHistoryAndKag() throws Exception {
        String user=register();
            mvc.perform(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON)
                .content("{\"message\":\"Căn cứ?\",\"contextId\":\"unsupported-session\"}"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(kag);
        mvc.perform(get("/api/chat").header("Authorization","Bearer "+user))
            .andExpect(status().isOk()).andExpect(jsonPath("$").isEmpty());
    }
    @Test @Transactional void verifiedNativeAbstentionPersistsProgressAndHistoryWithoutReclassifyingLegacyRows() throws Exception {
        String user=register(); UUID owner=UUID.fromString(body(mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andReturn()).path("id").asText());
        var legacy=new ChatMessage(); legacy.ownerId=owner; legacy.question="Không đủ căn cứ trong lần gọi lịch sử"; legacy.state="UNAVAILABLE"; chats.saveAndFlush(legacy);
        var wire=streamWire();
        try(var fixture=wire.new Fixture()) {
            fixture.status=503; fixture.body=KagClientTest.nativeAbstention(); fixture.identityHeaders=false;
            bridge(wire,fixture);
            var output=new ByteArrayOutputStream(); chat.progress(owner,new ChatRequest("Câu hỏi ngoài phạm vi chưa được phân loại","")).writeTo(output);
            String stream=output.toString(java.nio.charset.StandardCharsets.UTF_8);
            assertFalse(stream.contains("event: error"));
            var done=terminal(stream,"done");
            assertEquals("KAG_ABSTAINED",done.path("state").asText()); assertEquals("",done.path("answer").asText()); assertTrue(done.path("citations").isEmpty());
            var rows=body(mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
            assertEquals(2,rows.size()); int abstained=0;
            for(var row:rows) {
                if(row.path("id").asText().equals(legacy.id.toString())) assertEquals("UNAVAILABLE",row.path("state").asText());
                else {assertEquals("KAG_ABSTAINED",row.path("state").asText());assertEquals("",row.path("answer").asText());assertTrue(row.path("citations").isEmpty());abstained++;}
            }
            assertEquals(1,abstained); assertEquals(1,fixture.calls.get());
            assertEquals("KAG_ABSTAINED",chats.findById(UUID.fromString(done.path("id").asText())).orElseThrow().state);
        }
    }
    @ParameterizedTest @ValueSource(ints={401,403,422,503})
    @Transactional void realH1ErrorsNeverPersistAnsweredChatOrEmitDone(int status) throws Exception {
        var owner=streamOwner(); var wire=streamWire();
        try(var fixture=wire.new Fixture()) {
            fixture.status=status; fixture.body=KagClientTest.h1Failure(status);
            bridge(wire,fixture);
            var output=new ByteArrayOutputStream(); chat.progress(owner,new ChatRequest("Offline H1 progress","")).writeTo(output);
            String body=output.toString(java.nio.charset.StandardCharsets.UTF_8);
            assertEquals("UNAVAILABLE",terminal(body,"error").path("state").asText()); assertFalse(body.contains("event: done"));
            assertFalse(body.contains(KagClientTest.TOKEN)); assertFalse(body.contains(wire.secret.toString()));
            var stored=chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner); assertEquals(1,stored.size());
            for(var row:stored) { assertEquals("UNAVAILABLE",row.state); assertNull(row.answer); assertEquals("[]",row.citations); }
        }
    }
    @Test void chatDelegatesOnlyAuthenticatedOwnerAndRejectsBrowserIdentity() throws Exception {
        String user=register();
        UUID owner=UUID.fromString(body(mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andReturn()).path("id").asText());
        when(kag.query(any(),any(UUID.class))).thenAnswer(invocation->{
            Map<?,?> request=invocation.getArgument(0);
            assertEquals(owner,request.get("user_id")); assertInstanceOf(UUID.class,request.get("user_id"));
            UUID chatId=invocation.getArgument(1);
            assertEquals(owner,chats.findById(chatId).orElseThrow().ownerId);
            assertEquals(Set.of("user_id","message","context_id","schema_contract"),request.keySet());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Dịch vụ KAG chưa khả dụng");
        });
        mvc.perform(post("/api/chat/stream?progress=true").contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Căn cứ?\"}")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON)
            .content("{\"message\":\"Căn cứ?\",\"user_id\":\"00000000-0000-4000-8000-000000000001\"}")).andExpect(status().isBadRequest());
        verifyNoInteractions(kag);
        assertEquals("UNAVAILABLE",progressResponse(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user).header("X-User-ID",UUID.randomUUID().toString())
            .header("X-KAG-Token","forged-browser-token").contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Căn cứ?\"}"),"error").path("state").asText());
        verify(kag,times(1)).query(any(),any(UUID.class));
    }
    @Test void nativeAbstentionAndMixedInvalidCitationsCannotBecomeAnswers() throws Exception {
        String user=register();
        for(String response:List.of("{\"answer\":\"Không đủ căn cứ\",\"citations\":[]}",
            "{\"answer\":\"Nội dung thử\",\"citations\":[{\"doc_id\":\"missing\",\"unit_id\":\"missing::1\",\"quote\":\"Nguồn\"},{\"sign_id\":\"P.1\"}]}")) {
            when(kag.query(any(),any(UUID.class))).thenReturn(json.readTree(response));
            assertEquals("UNAVAILABLE",progressResponse(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user)
                .contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Căn cứ?\"}"),"error").path("state").asText());
        }
        var items=body(mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andReturn());
        assertEquals(2,items.size()); for(var item:items) { assertEquals("UNAVAILABLE",item.path("state").asText()); assertEquals("",item.path("answer").asText()); }
    }
    @Test void datasetGraphHistoryKeepsEachSnapshotWithoutWebappRecords() throws Exception {
        String user=register(),docId="dataset-only-"+UUID.randomUUID();
        assertTrue(contents.findByKindAndExternalId("documents",docId).isEmpty());
        var expected=new HashMap<String,JsonNode>();
        for(String graph:List.of("A","B")) {
            String quote="Nguyên văn graph "+graph+" · tiếng Việt 😀";
            var answer=json.createObjectNode().put("contract_version","graph-chat-v1").put("answer","Căn cứ "+graph);
            var citation=answer.putArray("citations").addObject().put("doc_id",docId).putNull("unit_id").put("sign_id","sign-1").put("quote",quote);
            citation.putObject("source").put("contract_version","graph-source-v1").put("release_id","release-"+graph).put("text",quote);
            when(kag.query(any(),any(UUID.class))).thenReturn(answer);
            var saved=progressResponse(post("/api/chat/stream?progress=true").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON)
                .content("{\"message\":\"Căn cứ graph "+graph+"?\"}"),"done");
            assertEquals("ANSWERED",saved.path("state").asText());
            expected.put(saved.path("id").asText(),answer.path("citations"));
        }
        assertTrue(contents.findByKindAndExternalId("documents",docId).isEmpty());
        var history=body(mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertEquals(2,history.size());for(var row:history)assertEquals(expected.get(row.path("id").asText()),row.path("citations"));
    }
    @Test void datasetViewAndSelectedTrialRequireAdminAndKeepExplicitTargets() throws Exception {
        String user=register();
        for(String path:List.of("/api/admin/kag/dataset/units","/api/admin/kag/graph/17/run-B/retrieve")) {
            if(path.endsWith("retrieve")) {
                mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Câu thử\",\"top_k\":3,\"expand\":false}")).andExpect(status().isUnauthorized());
                mvc.perform(post(path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Câu thử\",\"top_k\":3,\"expand\":false}")).andExpect(status().isForbidden());
            } else {
                mvc.perform(get(path)).andExpect(status().isUnauthorized());mvc.perform(get(path).header("Authorization","Bearer "+user)).andExpect(status().isForbidden());
            }
        }
        verifyNoInteractions(kag);
        when(kag.builderDataset("units",25,25)).thenReturn(json.createObjectNode().put("fixture","page"));
        mvc.perform(get("/api/admin/kag/dataset/units?offset=25&limit=25").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(header().string("Cache-Control","no-store"));
        verify(kag).builderDataset("units",25,25);
        when(kag.trialGraph(eq(17),eq("run-B"),any())).thenReturn(json.createObjectNode().put("fixture","trial-B"));
        mvc.perform(post("/api/admin/kag/graph/17/run-B/retrieve").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"message\":\"Câu thử\",\"top_k\":3,\"expand\":false}")).andExpect(status().isOk());
        verify(kag).trialGraph(eq(17),eq("run-B"),any());
        mvc.perform(get("/api/admin/kag/dataset/units?path=secret").header("Authorization","Bearer "+admin)).andExpect(status().isBadRequest());
    }
    record StreamSource(Content document,LegalUnit unit,ObjectNode answer) {}
    StreamSource streamSource() throws Exception {
        var doc=new Content(); doc.kind="documents"; doc.externalId="P5::"+UUID.randomUUID(); doc.published=true;
        doc.data=json.writeValueAsString(Map.of("doc_id",doc.externalId,"title","Nguồn giả lập P5","ngay_hieu_luc","2025-01-01"));
        contents.saveAndFlush(doc);
        var value=(ObjectNode)new KagClientTest().answer(); String quote=value.path("citations").get(0).path("quote").asText();
        var unit=new LegalUnit(); unit.documentId=doc.id; unit.unitId=doc.externalId+"::1"; unit.published=true;
        unit.data=json.writeValueAsString(Map.of("doc_id",doc.externalId,"unit_id",unit.unitId,"text",quote)); legalUnits.saveAndFlush(unit);
        var citation=(ObjectNode)value.path("citations").get(0); citation.put("doc_id",doc.externalId).put("unit_id",unit.unitId);
        return new StreamSource(doc,unit,value);
    }
    UUID streamOwner() throws Exception {
        String user=register(); return UUID.fromString(body(mvc.perform(get("/api/auth/me").header("Authorization","Bearer "+user)).andReturn()).path("id").asText());
    }
    KagClientTest streamWire() throws Exception {
        var wire=new KagClientTest(); wire.temporary=streamTemporary; wire.setup(); return wire;
    }
    void bridge(KagClientTest wire,KagClientTest.Fixture fixture) {
        var actual=wire.client(fixture);
        when(kag.query(any(),any(UUID.class))).thenAnswer(call->actual.query(call.getArgument(0),call.getArgument(1)));
    }
    @Test @Transactional void realQueryPersistsBeforeDownstreamDone() throws Exception {
            var source=streamSource(); var owner=streamOwner(); var wire=streamWire();
            try(var fixture=wire.new Fixture()) {
                fixture.body=source.answer().toString();
                bridge(wire,fixture); var output=new ByteArrayOutputStream();
                chat.progress(owner,new ChatRequest("Căn cứ P5?","")).writeTo(output);
                String text=output.toString(java.nio.charset.StandardCharsets.UTF_8);
                assertEquals("ANSWERED",terminal(text,"done").path("state").asText()); assertFalse(text.contains("event: error\n"));
                var stored=chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner).getFirst();
                assertEquals("ANSWERED",stored.state); assertEquals(source.answer().path("answer").asText(),stored.answer);
                assertEquals(source.answer().path("citations"),json.readTree(stored.citations));
            }
    }
    @ParameterizedTest @ValueSource(strings={"document-unpublished","unit-unpublished","wrong-document","quote-changed","expired-document","mixed-invalid"})
    @Transactional void rejectedLegalEvidenceNeverPersistsAnswerOrEmitsDownstreamDone(String mode) throws Exception {
        var source=streamSource(); var owner=streamOwner(); var wire=streamWire();
        switch(mode) {
            case "document-unpublished" -> { source.document().published=false; contents.saveAndFlush(source.document()); }
            case "unit-unpublished" -> { source.unit().published=false; legalUnits.saveAndFlush(source.unit()); }
            case "wrong-document" -> { var data=(ObjectNode)json.readTree(source.unit().data); data.put("doc_id","foreign"); source.unit().data=data.toString(); legalUnits.saveAndFlush(source.unit()); }
            case "quote-changed" -> { var data=(ObjectNode)json.readTree(source.unit().data); data.put("text","Nội dung khác"); source.unit().data=data.toString(); legalUnits.saveAndFlush(source.unit()); }
            case "expired-document" -> { var data=(ObjectNode)json.readTree(source.document().data); data.put("ngay_het_hieu_luc","2000-01-01"); source.document().data=data.toString(); contents.saveAndFlush(source.document()); }
            default -> { var invalid=source.answer().path("citations").get(0).deepCopy(); ((ObjectNode)invalid).put("doc_id","missing"); ((ArrayNode)source.answer().path("citations")).add(invalid); }
        }
        try(var fixture=wire.new Fixture()) {
            fixture.body=source.answer().toString();
            bridge(wire,fixture); var output=new ByteArrayOutputStream(); chat.progress(owner,new ChatRequest("Căn cứ P5?","")).writeTo(output);
            String text=output.toString(java.nio.charset.StandardCharsets.UTF_8);
            assertFalse(text.contains("event: done\n")); assertTrue(text.contains("event: error\n"));
            var stored=chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner).getFirst();
            assertEquals("UNAVAILABLE",stored.state); assertTrue(stored.answer==null||stored.answer.isEmpty()); assertEquals(json.createArrayNode(),json.readTree(stored.citations));
        }
    }
    @ParameterizedTest @ValueSource(strings={"empty","truncated-json","malformed-utf8","invalid-answer"})
    @Transactional void incompleteTransportLeavesUnavailableWithoutPartialAnswer(String mode) throws Exception {
        var source=streamSource(); var owner=streamOwner(); var wire=streamWire();
        try(var fixture=wire.new Fixture()) {
            fixture.raw=(switch(mode) {
                case "empty" -> "";
                case "truncated-json" -> source.answer().toString().substring(0,source.answer().toString().length()-1);
                default -> "{\"answer\":\"fabricated\",\"citations\":[]}";
            }).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if(mode.equals("malformed-utf8")) fixture.raw=new byte[]{(byte)0xc3,0x28};
            bridge(wire,fixture); var output=new ByteArrayOutputStream(); chat.progress(owner,new ChatRequest("Căn cứ P5?","")).writeTo(output);
            String text=output.toString(java.nio.charset.StandardCharsets.UTF_8);
            assertFalse(text.contains("event: done\n")); assertTrue(text.contains("event: error\n"));
            var stored=chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner).getFirst();
            assertEquals("UNAVAILABLE",stored.state); assertTrue(stored.answer==null||stored.answer.isEmpty());
        }
    }
    @Test @Transactional void disconnectAfterCompletedValidDoneKeepsPersistedEvidence() throws Exception {
        var source=streamSource(); var owner=streamOwner(); var wire=streamWire();
        TestTransaction.flagForCommit(); TestTransaction.end();
        try(var fixture=wire.new Fixture()) {
            fixture.body=source.answer().toString(); bridge(wire,fixture);
            var output=new OutputStream() {
                @Override public void write(int value) throws IOException { throw new IOException("Synthetic downstream disconnect"); }
                @Override public void write(byte[] bytes,int offset,int length) throws IOException {
                    if(!new String(bytes,offset,length,java.nio.charset.StandardCharsets.UTF_8).startsWith("event: done\n")) return;
                    var stored=chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner).getFirst();
                    assertEquals("ANSWERED",stored.state);
                    assertEquals(source.answer().path("answer").asText(),stored.answer);
                    assertEquals(source.answer().path("citations").toString(),stored.citations);
                    throw new IOException("Synthetic downstream disconnect");
                }
            };
            assertThrows(UncheckedIOException.class,()->chat.progress(owner,new ChatRequest("Căn cứ P5?","")).writeTo(output));
            var stored=chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner).getFirst();
            assertEquals(source.answer().path("answer").asText(),stored.answer);
            assertEquals(source.answer().path("citations"),json.readTree(stored.citations));
        } finally {
            chats.deleteAll(chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner));
            legalUnits.deleteById(source.unit().id); contents.deleteById(source.document().id); accounts.deleteById(owner);
            TestTransaction.start();
        }
    }
}
