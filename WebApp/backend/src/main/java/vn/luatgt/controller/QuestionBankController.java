package vn.luatgt.controller;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.springframework.web.bind.annotation.*;
import vn.luatgt.service.QuestionBankService;

@RestController @RequestMapping("/api")
public class QuestionBankController {
    private final QuestionBankService service;
    public QuestionBankController(QuestionBankService service) {this.service=service;}
    @GetMapping("/admin/questions/sets") List<ObjectNode> sets() {return service.sets();}
    @PostMapping("/admin/questions/sets") ObjectNode set(@RequestBody ObjectNode request) {return service.createSet(request);}
    @PutMapping("/admin/questions/sets/{id}") void updateSet(@PathVariable java.util.UUID id,@RequestBody ObjectNode request) {service.updateSet(id,request);}
    @DeleteMapping("/admin/questions/sets/{id}") void deleteSet(@PathVariable java.util.UUID id) {service.deleteSet(id);}
    @GetMapping("/admin/questions/rules") List<ObjectNode> rules() {return service.rules(false);}
    @PostMapping("/admin/questions/rules") ObjectNode rule(@RequestBody ObjectNode request) {return service.createRule(request);}
    @PutMapping("/admin/questions/rules/{id}") ObjectNode updateRule(@PathVariable java.util.UUID id,@RequestBody ObjectNode request) {return service.updateRule(id,request);}
    @DeleteMapping("/admin/questions/rules/{id}") void deleteRule(@PathVariable java.util.UUID id) {service.deleteRule(id);}
    @PostMapping("/admin/questions/rules/{id}/end") void end(@PathVariable java.util.UUID id,@RequestBody ObjectNode request) {service.endRule(id,request);}
    @GetMapping("/exam-rules") List<ObjectNode> available() {return service.rules(true);}
    @GetMapping("/question-sets") List<ObjectNode> availableSets() {return service.sets();}
}
