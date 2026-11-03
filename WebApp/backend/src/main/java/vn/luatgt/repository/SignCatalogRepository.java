package vn.luatgt.repository;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.model.Content;
import static vn.luatgt.repository.LearningCatalogRepository.*;

@Repository
public class SignCatalogRepository {
    private final JdbcTemplate db; private final ObjectMapper json;
    public SignCatalogRepository(JdbcTemplate db,ObjectMapper json) {this.db=db;this.json=json;}
    public void sync(Content c,ObjectNode n) {
        String group=n.path("group").asText();String qcvn=n.path("qcvn").asText(null);
        if(db.queryForObject("SELECT COUNT(*) FROM nhom_enum WHERE nhom_id=?",Long.class,group)==0) db.update("INSERT INTO nhom_enum VALUES (?,?)",group,group);
        if(qcvn!=null&&db.queryForObject("SELECT COUNT(*) FROM qcvn_enum WHERE qcvn_id=?",Long.class,qcvn)==0) db.update("INSERT INTO qcvn_enum VALUES (?,?)",qcvn,qcvn);
        byte[] image=null;
        if(n.hasNonNull("imageKey")) {
            String key=n.path("imageKey").asText();var images=db.query("SELECT image_id FROM images WHERE image_url=?",(rs,i)->rs.getBytes(1),key);
            image=images.isEmpty()?binary(UUID.randomUUID()):images.getFirst();
            if(images.isEmpty()) db.update("INSERT INTO images VALUES (?,?,?,?)",image,key,n.path("imageFileName").asText(null),"{\"mime\":\""+n.path("imageMime").asText("image/png")+"\"}");
        }
        Object[] args={n.path("code").asText(),group,n.path("name").asText(),n.path("meaning").asText(null),qcvn,n.path("record_type").asText(null),n.path("parent_code").asText(null),n.hasNonNull("children_codes")?n.path("children_codes").toString():null,n.path("description_scope").asText(null),n.path("unit_id").asText(null),n.hasNonNull("image_required")?n.path("image_required").asBoolean():null,image,n.path("image_status").asText(null),n.path("verification_status").asText(null),n.hasNonNull("note")?n.path("note").toString():null,binary(c.id)};
        if(db.update("UPDATE signs SET ma_bien=?,nhom=?,ten=?,mo_ta=?,qcvn=?,record_type=?,parent_code=?,children_codes=?,description_scope=?,unit_id=?,image_required=?,image_id=?,image_status=?,verification_status=?,note=? WHERE content_id=?",args)==0) {
            db.update("INSERT INTO signs(sign_id,content_id,ma_bien,nhom,ten) VALUES (?,?,?,?,?)",c.externalId,binary(c.id),n.path("code").asText(),group,n.path("name").asText());
            db.update("UPDATE signs SET ma_bien=?,nhom=?,ten=?,mo_ta=?,qcvn=?,record_type=?,parent_code=?,children_codes=?,description_scope=?,unit_id=?,image_required=?,image_id=?,image_status=?,verification_status=?,note=? WHERE content_id=?",args);
        }
    }
    public ObjectNode read(Content c,ObjectNode n) {
        var rows=db.queryForList("SELECT s.*,i.image_url,i.metadata FROM signs s LEFT JOIN images i ON i.image_id=s.image_id WHERE s.content_id=?",binary(c.id));
        if(rows.isEmpty()) return n;
        var row=rows.getFirst();var normalized=new HashMap<String,Object>();row.forEach((key,value)->normalized.put(key.toLowerCase(Locale.ROOT),value));
        for(String[] pair:new String[][]{{"sign_id","sign_id"},{"ma_bien","code"},{"nhom","group"},{"ten","name"},{"mo_ta","meaning"},{"qcvn","qcvn"},{"record_type","record_type"},{"parent_code","parent_code"},{"description_scope","description_scope"},{"unit_id","unit_id"},{"image_required","image_required"},{"image_status","image_status"},{"verification_status","verification_status"}}) {
            Object value=normalized.get(pair[0]);if(value!=null)n.set(pair[1],json.valueToTree(value));
        }
        for(String field:List.of("children_codes","note")) if(normalized.get(field)!=null) try { n.set(field,json.readTree(normalized.get(field).toString())); } catch(Exception e) {throw new IllegalStateException(e);}
        if(normalized.get("image_id") instanceof byte[] bytes)n.put("image_id",uuid(bytes).toString());
        return n;
    }
    public void validateRelations(ObjectNode n) {
        db.queryForList("SELECT sign_id FROM signs ORDER BY sign_id FOR UPDATE");
        String code=n.path("code").asText(),version=n.path("qcvn").asText();var seen=new HashSet<String>();seen.add(code);
        String parent=n.path("parent_code").asText("");
        while(!parent.isBlank()) {
            if(!seen.add(parent))throw ApiErrors.bad("Quan hệ cha biển báo có chu trình trong cùng QCVN");
            var rows=db.queryForList("SELECT parent_code FROM signs WHERE qcvn=? AND ma_bien=?",version,parent);
            if(rows.size()!=1)throw ApiErrors.bad("Mã biển cha thiếu hoặc không duy nhất trong cùng QCVN: "+parent);
            Object value=rows.getFirst().values().iterator().next();parent=value==null?"":value.toString();
        }
        for(var child:n.path("children_codes")) {
            var rows=db.queryForList("SELECT parent_code FROM signs WHERE qcvn=? AND ma_bien=?",version,child.asText());
            if(rows.size()!=1||!code.equals(rows.getFirst().values().iterator().next()))throw ApiErrors.bad("Biển con phải tồn tại và trỏ về đúng cha trong cùng QCVN: "+child.asText());
        }
    }
}
