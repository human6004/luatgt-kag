import java.nio.file.Files;
import java.nio.file.Paths;
import javassist.ClassPool;
import javassist.CtClass;
import javassist.CannotCompileException;
import javassist.expr.ExprEditor;
import javassist.expr.MethodCall;

public class PatchOpenSpgModelId {
    public static void main(String[] args) throws Exception {
        CtClass repository;
        try (java.io.InputStream input = Files.newInputStream(Paths.get(args[0]))) {
            repository = new ClassPool(true).makeClass(input);
        }
        final int[] replacements = {0};
        repository.getDeclaredMethod("getByModelId").instrument(new ExprEditor() {
            @Override public void edit(MethodCall call) throws CannotCompileException {
                if (call.getClassName().equals("java.lang.String")
                        && call.getMethodName().equals("split")
                        && call.getSignature().equals("(Ljava/lang/String;)[Ljava/lang/String;")) {
                    call.replace("$_ = $0.split($1, 2);");
                    replacements[0]++;
                }
            }
        });
        if (replacements[0] != 1) {
            throw new IllegalStateException("Expected one model ID split in pinned OpenSPG");
        }
        Files.write(Paths.get(args[0]), repository.toBytecode());
        repository.detach();
    }
}
