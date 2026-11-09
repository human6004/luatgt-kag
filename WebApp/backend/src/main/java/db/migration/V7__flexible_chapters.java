package db.migration;

import java.util.ArrayList;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;

public class V7__flexible_chapters extends BaseJavaMigration {
    @Override public void migrate(Context context) throws Exception {
        var connection=context.getConnection();
        boolean mysql=connection.getMetaData().getDatabaseProductName().equalsIgnoreCase("MySQL");
        var names=new ArrayList<String>();
        String schema=mysql?connection.getCatalog():connection.getSchema();
        try(var query=connection.prepareStatement("SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE LOWER(tc.TABLE_NAME)='topic' AND tc.CONSTRAINT_SCHEMA=? AND tc.CONSTRAINT_TYPE='CHECK'")) {
            query.setString(1,schema);
            try(var rows=query.executeQuery()) {
                while(rows.next())if(rows.getString(2).toLowerCase(java.util.Locale.ROOT).contains("chapter"))names.add(rows.getString(1));
            }
        }
        try(var statement=connection.createStatement()) {
            for(String name:names) {
                String quoted=mysql?"`"+name.replace("`","``")+"`":"\""+name.replace("\"","\"\"")+"\"";
                statement.execute("ALTER TABLE topic DROP "+(mysql?"CHECK ":"CONSTRAINT ")+quoted);
            }
            statement.execute("ALTER TABLE topic ADD CONSTRAINT topic_chapter_positive CHECK(chapter > 0)");
        }
    }
}
