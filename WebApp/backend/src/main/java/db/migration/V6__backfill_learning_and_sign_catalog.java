package db.migration;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import vn.luatgt.model.Content;
import vn.luatgt.repository.LearningCatalogRepository;
import vn.luatgt.repository.SignCatalogRepository;

public class V6__backfill_learning_and_sign_catalog extends BaseJavaMigration {
    @Override public void migrate(Context context) throws Exception {
        var json=new ObjectMapper();var db=new JdbcTemplate(new SingleConnectionDataSource(context.getConnection(),true));
        var bank=new LearningCatalogRepository(db,json);var signs=new SignCatalogRepository(db,json);
        var rows=db.queryForList("SELECT id,kind,external_id,data,published,version FROM content WHERE kind IN ('questions','signs')");
        for(var row:rows) {
            var fields=new java.util.HashMap<String,Object>();row.forEach((key,value)->fields.put(key.toLowerCase(java.util.Locale.ROOT),value));
            var c=new Content();c.id=LearningCatalogRepository.uuid((byte[])fields.get("id"));c.kind=fields.get("kind").toString();c.externalId=fields.get("external_id").toString();c.data=fields.get("data").toString();c.published=Boolean.parseBoolean(fields.get("published").toString());c.version=((Number)fields.get("version")).longValue();
            var n=(ObjectNode)json.readTree(c.data);
            if(c.kind.equals("questions")&&c.published) bank.publish(c,n);
            if(c.kind.equals("signs")) {
                for(String[] alias:new String[][]{{"code","ma_bien"},{"name","ten"},{"group","nhom"},{"meaning","mo_ta"}})if(!n.hasNonNull(alias[0])&&n.hasNonNull(alias[1]))n.set(alias[0],n.get(alias[1]));
                if(c.published&&n.hasNonNull("imageKey")&&!n.hasNonNull("image_status"))n.put("image_status","verified");
                signs.sync(c,n);
            }
        }
        if(!rows.isEmpty()&&bank.sets().stream().anyMatch(s->s.path("set_code").asText().equals("LEGACY"))) {
            var n=json.createObjectNode().put("setId",bank.legacySet().toString()).put("license","B").put("validFrom",java.time.LocalDate.now().toString()).put("totalQuestions",30).put("durationMinutes",20).put("minimumCorrect",27).put("criticalSlots",1).put("failOnCritical",true);
            n.set("quotas",json.valueToTree(new int[]{8,1,1,1,9,9}));bank.createRule(n);
        }
        // Legacy answer indexes and rules stay in their original tables; do not invent missing selections.
    }
}
