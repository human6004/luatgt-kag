package db.migration;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

public class V8__sign_visual_description extends BaseJavaMigration {
    @Override public void migrate(Context context) throws Exception {
        var db=new JdbcTemplate(new SingleConnectionDataSource(context.getConnection(),true));
        db.execute("ALTER TABLE signs ADD COLUMN visual_description LONGTEXT");
        var json=new ObjectMapper();
        for(var row:db.queryForList("SELECT c.id,c.data FROM signs s JOIN content c ON c.id=s.content_id")) {
            var data=json.readTree(row.get("data").toString());
            if(data.path("visual_description").isTextual()) db.update("UPDATE signs SET visual_description=? WHERE content_id=?",data.path("visual_description").asText(),row.get("id"));
        }
    }
}
