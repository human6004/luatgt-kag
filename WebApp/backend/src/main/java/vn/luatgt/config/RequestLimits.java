package vn.luatgt.config;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class RequestLimits extends OncePerRequestFilter {
    public static final int JSON_BYTES=10*1024*1024;
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        if(request.getContentType()==null||!request.getContentType().toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) { chain.doFilter(request,response); return; }
        if(request.getContentLengthLong()>JSON_BYTES) { response.sendError(413); return; }
        chain.doFilter(new HttpServletRequestWrapper(request) {
            @Override public ServletInputStream getInputStream() throws IOException {
                var source=super.getInputStream();
                return new ServletInputStream() {
                    int count;
                    @Override public int read() throws IOException { int next=source.read(); if(next>=0&&++count>JSON_BYTES) throw new IOException("JSON body limit exceeded"); return next; }
                    @Override public boolean isFinished() { return source.isFinished(); }
                    @Override public boolean isReady() { return source.isReady(); }
                    @Override public void setReadListener(ReadListener listener) { source.setReadListener(listener); }
                };
            }
        },response);
    }
}
