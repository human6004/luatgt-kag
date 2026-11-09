package vn.luatgt.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.file.*;
import java.util.HashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class SignDatasetImages {
    private final Map<String, Path> images = new HashMap<>();

    public SignDatasetImages(@Value("${app.sign-image-directory:data/processed/signs/dataset_signs}") String directory) throws IOException {
        Path root = Path.of(directory);
        if (!Files.isDirectory(root)) return;
        try (var paths = Files.walk(root)) {
            paths.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                .filter(path -> path.getFileName().toString().endsWith(".svg"))
                .sorted()
                .forEach(path -> images.putIfAbsent(path.getFileName().toString(), path));
        }
    }

    Path find(JsonNode sign) {
        if (!"QCVN 41:2024/BGTVT".equals(sign.path("qcvn").asText())) return null;
        Path path = images.get(sign.path("code").asText() + ".svg");
        return path != null && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.isReadable(path)
            ? path : null;
    }
}
