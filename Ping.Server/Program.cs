using Microsoft.AspNetCore.HttpOverrides;
using Ping.Server.Hubs;

var builder = WebApplication.CreateBuilder(args);

// Add services
builder.Services.AddControllersWithViews();
builder.Services.AddRazorPages();

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
    options.MaximumReceiveMessageSize = 2 * 1024 * 1024; // 2 MB
})
.AddMessagePackProtocol(); // <-- enable MessagePack

// CORS for dev and prod
builder.Services.AddCors(o =>
{
    o.AddPolicy("dev", p =>
        p.WithOrigins("https://localhost:51520")
         .AllowAnyHeader()
         .AllowAnyMethod()
         .AllowCredentials());

    o.AddPolicy("prod", p =>
        p.WithOrigins("https://ping.vera.fo")
         .AllowAnyHeader()
         .AllowAnyMethod()
         .AllowCredentials());
});

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// Respect X-Forwarded-* from nginx
var fwd = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
};
// Trust all proxies/networks (nginx in same docker network)
fwd.KnownNetworks.Clear();
fwd.KnownProxies.Clear();
app.UseForwardedHeaders(fwd);

// Optional: keep this if you want direct HTTP->HTTPS redirects when not behind proxy.
// Behind nginx, forwarded headers will prevent redirect loops.
app.UseHttpsRedirection();

app.UseStaticFiles();
app.UseRouting();

app.UseCors();

app.MapRazorPages();
app.MapControllers();

var corsPolicy = app.Environment.IsDevelopment() ? "dev" : "prod";
app.MapHub<AudioHub>("/voice").RequireCors(corsPolicy);

app.MapFallbackToFile("index.html");

app.Run();