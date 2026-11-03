package vn.luatgt.repository;

import java.util.*;
import org.springframework.data.jpa.repository.*;
import vn.luatgt.model.ChatMessage;

public interface ChatRepository extends JpaRepository<ChatMessage,UUID> {
    List<ChatMessage> findTop50ByOwnerIdOrderByCreatedAtDesc(UUID owner);
    @Query("select c from ChatMessage c where c.feedback in ('WRONG','NO_BASIS','OUTDATED') and (:pending=false or c.resolved=false) order by c.createdAt desc")
    List<ChatMessage> reported(@org.springframework.data.repository.query.Param("pending") boolean pending,org.springframework.data.domain.Pageable page);
    @Query("select count(c) from ChatMessage c where c.feedback in ('WRONG','NO_BASIS','OUTDATED') and (:pending=false or c.resolved=false)")
    long reportedCount(@org.springframework.data.repository.query.Param("pending") boolean pending);
    @Modifying
    @Query("update ChatMessage c set c.resolved=true,c.resolution=:note where c.id=:id and c.feedback in ('WRONG','NO_BASIS','OUTDATED')")
    int resolveReported(@org.springframework.data.repository.query.Param("id") UUID id,@org.springframework.data.repository.query.Param("note") String note);
}

