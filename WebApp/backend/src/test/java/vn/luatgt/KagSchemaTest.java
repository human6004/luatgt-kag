package vn.luatgt;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.MediaType;
import org.springframework.web.server.ResponseStatusException;
import vn.luatgt.dto.*;
import vn.luatgt.integration.*;
import vn.luatgt.model.Content;
import vn.luatgt.repository.*;
import vn.luatgt.service.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest @AutoConfigureMockMvc @Transactional
class KagSchemaTest {
    @Autowired MockMvc mvc; @Autowired ObjectMapper json; @Autowired KagSchema schema;
    @Autowired ContentService content; @Autowired LegalUnitService units; @Autowired ChatService chat;
    @Autowired ContentRepository documents; @Autowired LegalUnitRepository records; @Autowired AccountRepository accounts;
    @MockitoBean RateLimit rate; @MockitoBean KagClient kag; @MockitoBean ObjectStorage storage;
    ObjectNode node(String value) throws Exception { return (ObjectNode)json.readTree(value); }
    Content document(boolean published) throws Exception {
        var doc=new Content(); doc.kind="documents"; doc.externalId="KAG::"+UUID.randomUUID(); doc.published=published;
        doc.data=json.writeValueAsString(Map.of("doc_id",doc.externalId,"externalId",doc.externalId,"title","Nguồn thử","so_hieu","TEST","source","test","reviewed",true,"fileKey","test-pdf","ngay_hieu_luc","2025-01-01"));
        return documents.saveAndFlush(doc);
    }
    ObjectNode unit(Content doc,String id,String parent) {
        var n=json.createObjectNode().put("unit_id",id).put("doc_id",doc.externalId).put("so_hieu","TEST").put("unit_type","Dieu")
            .put("text","Giữ nguyên văn bản pháp lý. Nội dung trích dẫn.").put("order",0).put("reviewed",true);
        if(parent==null)n.putNull("parent_id");else n.put("parent_id",parent); return n;
    }
    @Test void sharedContractAndNativeValuesKeepSourceIdentity() throws Exception {
        byte[] bytes=Files.readAllBytes(Path.of("../../kag/schema/schema_contract.json"));
        assertEquals(json.readTree(bytes),schema.contract());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),schema.identity().get("contract_sha256"));
        byte[] schemaBytes=Files.readAllBytes(Path.of("../../kag/schema/VietRoadTraffic.schema"));
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(schemaBytes)),schema.identity().get("schema_sha256"));
        assertEquals(schema.contract().path("runtime_contract").path("schema_sha256").asText(),schema.identity().get("schema_sha256"));
        assertEquals(Set.of("namespace","schema_sha256","contract_sha256"),schema.identity().keySet());
        var n=schema.normalize("units",node("{\"id\":\" D::1::occ2 \",\"name\":\" D::1::occ2 \",\"docId\":\"D\",\"unitType\":\"Dieu\",\"order\":0,\"penaltyPhatTienMin\":0,\"penaltyCanhCao\":false,\"parentId\":null,\"sourceRecord\":\"{\\\"value\\\":null}\"}"));
        assertEquals(" D::1::occ2 ",n.path("unit_id").asText()); assertEquals("D",n.path("doc_id").asText());
        assertTrue(n.path("parent_id").isNull()); assertEquals(0,n.path("penalty_phat_tien_min").asInt()); assertFalse(n.path("penalty_canh_cao").asBoolean());
        assertTrue(n.path("source_record").path("value").isNull()); assertFalse(n.has("docId"));
        assertThrows(ResponseStatusException.class,()->schema.normalize("units",node("{\"unit_id\":\"A\",\"id\":\"B\"}")));
        assertThrows(ResponseStatusException.class,()->schema.normalize("units",node("{\"unit_type\":\"Article\"}")));
        assertThrows(ResponseStatusException.class,()->schema.normalize("units",node("{\"penalty_phat_tien_min\":false}")));
        assertThrows(ResponseStatusException.class,()->schema.normalize("units",node("{\"unit_id\":\"D::1\",\"penalty_id\":\"D::2\"}")));
        assertThrows(ResponseStatusException.class,()->schema.normalize("units",node("{\"sourceRecord\":\"\"}")));
        assertThrows(ResponseStatusException.class,()->schema.normalize("documents",node("{\"effective_from\":\"2025-01-01\",\"ngay_hieu_luc\":\"2026-01-01\"}")));
        var doc=content.validate("documents",node("{\"doc_id\":\" D \",\"title\":\" Tiêu đề nguồn \",\"effective_from\":\"2025-01-01\"}"),false);
        assertEquals(" D ",doc.path("externalId").asText()); assertEquals(" Tiêu đề nguồn ",doc.path("title").asText()); assertEquals("2025-01-01",doc.path("ngay_hieu_luc").asText());
        assertFalse(doc.has("ngay_het_hieu_luc"));
        mvc.perform(get("/api/admin/kag/schema")).andExpect(status().isUnauthorized());
        var login=mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content("{\"email\":\"admin@test.vn\",\"password\":\"TEST-only-admin-password\"}")).andReturn();
        String token=json.readTree(login.getResponse().getContentAsString()).path("accessToken").asText();
        mvc.perform(get("/api/admin/kag/schema").header("Authorization","Bearer "+token)).andExpect(status().isOk()).andExpect(jsonPath("$.identity.namespace").value("VietRoadTraffic"))
            .andExpect(jsonPath("$.identity.schema_sha256").value(schema.identity().get("schema_sha256")))
            .andExpect(jsonPath("$.identity.contract_sha256").value(schema.identity().get("contract_sha256")))
            .andExpect(jsonPath("$.identity.schema_version").doesNotExist()).andExpect(jsonPath("$.identity.dataset_version").doesNotExist());
        mvc.perform(post("/api/admin/imports/units/preview").header("Authorization","Bearer "+token).contentType(MediaType.APPLICATION_JSON).content("{\"rows\":[{\"unit_id\":\"missing\"}]}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$[0].valid").value(false));
    }
    @Test void unitsRespectParentsAtomicImportAndPublication() throws Exception {
        var doc=document(false); String root=doc.externalId+"::1",child=root+"::k1";
        var request=new ImportRequest(List.of(unit(doc,child,root),unit(doc,root,null)),false);
        assertTrue(units.preview(request).stream().allMatch(r->Boolean.TRUE.equals(r.get("valid"))));
        assertEquals(2,units.confirm(request).get("inserted")); assertEquals(2,units.confirm(request).get("skipped"));
        var r=records.findByUnitId(root).orElseThrow(); assertFalse(r.published);
        assertThrows(ResponseStatusException.class,()->units.publish(r.id,new PublicationRequest(r.version,true)));
        doc.published=true; documents.saveAndFlush(doc); units.publish(r.id,new PublicationRequest(r.version,true));
        assertTrue(units.citation(doc.externalId,root,"Nội dung trích dẫn."));
        var c=records.findByUnitId(child).orElseThrow(); units.publish(c.id,new PublicationRequest(c.version,true));
        assertEquals(2,units.list(doc.externalId,false).size());
        long count=records.count();
        var a=unit(doc,root+"::a",root+"::b"); var b=unit(doc,root+"::b",root+"::a");
        assertThrows(ResponseStatusException.class,()->units.confirm(new ImportRequest(List.of(a,b),false))); assertEquals(count,records.count());
        var other=document(true);
        assertThrows(ResponseStatusException.class,()->units.confirm(new ImportRequest(List.of(unit(other,"wrong-doc",root)),false)));
        var change=unit(doc,root+"::changed",null);
        assertThrows(ResponseStatusException.class,()->units.edit(r.id,new ContentChangeRequest(r.version,change)));
    }
    @Test void chatRequiresPublishedUnitMatchingDocumentAndExactQuote() throws Exception {
        var doc=document(true); String id=doc.externalId+"::1"; units.confirm(new ImportRequest(List.of(unit(doc,id,null)),false));
        var record=records.findByUnitId(id).orElseThrow();
        UUID owner=accounts.findByEmail("admin@test.vn").orElseThrow().id;
        var response=json.createObjectNode().put("answer","Theo căn cứ nguồn."); var citation=response.putArray("citations").addObject().put("doc_id",doc.externalId).put("unit_id",id).put("quote","Nội dung trích dẫn.");
        when(kag.query(any(),any(UUID.class))).thenAnswer(invocation->{ Map<?,?> request=invocation.getArgument(0); assertEquals(schema.identity(),request.get("schema_contract")); return response; });
        var question=new ChatRequest("Căn cứ nào?",null);
        assertProgressState(owner,question,"UNAVAILABLE");
        units.publish(record.id,new PublicationRequest(record.version,true)); assertProgressState(owner,question,"ANSWERED");
        citation.put("quote","Đoạn không có trong nguồn"); assertProgressState(owner,question,"UNAVAILABLE");
        citation.put("quote","Nội dung trích dẫn.").put("doc_id",document(true).externalId); assertProgressState(owner,question,"UNAVAILABLE");
        citation.put("doc_id",doc.externalId).put("unit_id","unknown"); assertProgressState(owner,question,"UNAVAILABLE");
    }
    void assertProgressState(UUID owner,ChatRequest question,String state) throws Exception {
        var output=new java.io.ByteArrayOutputStream(); chat.progress(owner,question).writeTo(output);
        String stream=output.toString(java.nio.charset.StandardCharsets.UTF_8);
        String event=state.equals("ANSWERED")?"done":"error";
        String marker="event: "+event+"\ndata: "; int start=stream.indexOf(marker); assertTrue(start>=0,stream);
        assertEquals(state,json.readTree(stream.substring(start+marker.length()).split("\n\n",2)[0]).path("state").asText());
    }
    @Test void signsUseDisplayNameAndPublishedSourceLinks() throws Exception {
        var doc=document(true); String id=doc.externalId+"::qcvn"; units.confirm(new ImportRequest(List.of(unit(doc,id,null)),false));
        var sign=node("{\"id\":\"QCVN2024::P.1\",\"name\":\"QCVN2024::P.1\",\"maBien\":\"P.1\",\"ten\":\" Tên biển nguồn \",\"nhom\":\"Cấm\",\"moTa\":\"Nguồn nguyên văn\",\"qcvn\":\"QCVN 41:2024\",\"soHieu\":\"TEST\",\"ngayHieuLuc\":\"2025-01-01\",\"reviewed\":true,\"imageKey\":\"test-image\"}");
        sign.put("doc_id",doc.externalId).put("unit_id",id);
        var normalized=content.validate("signs",sign,false); assertEquals(" Tên biển nguồn ",normalized.path("name").asText());
        assertThrows(ResponseStatusException.class,()->content.validate("signs",sign,true));
        var u=records.findByUnitId(id).orElseThrow(); units.publish(u.id,new PublicationRequest(u.version,true));
        normalized=content.validate("signs",sign,true);
        var stored=new Content(); stored.kind="signs"; stored.externalId=normalized.path("externalId").asText(); stored.data=normalized.toString();stored.published=true;documents.saveAndFlush(stored);
        assertTrue(content.isEffective(stored)); doc.published=false;documents.saveAndFlush(doc);assertFalse(content.isEffective(stored));
        sign.put("code","P.2"); assertThrows(ResponseStatusException.class,()->content.validate("signs",sign,false));
    }
}
