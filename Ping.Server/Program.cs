using Microsoft.AspNetCore.HttpOverrides;
using Ping.Server.Hubs;

var builder = WebApplication.CreateBuilder(args);

// MVC/Swagger
builder.Services.AddControllersWithViews();
builder.Services.AddRazorPages();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// SignalR + MessagePack
builder.Services.AddSignalR(o =>
{
    o.EnableDetailedErrors = true;
    o.MaximumReceiveMessageSize = 2 * 1024 * 1024;
})
.AddMessagePackProtocol();

// CORS (dev + prod)
builder.Services.AddCors(o =>
{
    o.AddPolicy("dev", p => p
        .WithOrigins("https://localhost:51520")
        .AllowAnyHeader().AllowAnyMethod().AllowCredentials());

    o.AddPolicy("prod", p => p
        .WithOrigins("https://ping.vera.fo")
        .AllowAnyHeader().AllowAnyMethod().AllowCredentials());
});

var app = builder.Build();

if (!app.Environment.IsDevelopment()) app.UseHsts();
if (app.Environment.IsDevelopment()) { app.UseSwagger(); app.UseSwaggerUI(); }

// IMPORTANT: respect proxy headers before redirects
var fwd = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
};
fwd.KnownNetworks.Clear();
fwd.KnownProxies.Clear();
app.UseForwardedHeaders(fwd);

app.UseHttpsRedirection();

app.UseStaticFiles();
app.UseRouting();

app.UseCors();

app.MapRazorPages();
app.MapControllers();

var corsPolicy = app.Environment.IsDevelopment() ? "dev" : "prod";
app.MapHub<AudioHub>("/voice").RequireCors(corsPolicy);

// Optional SPA fallback only if you actually serve a SPA from this app
// app.MapFallbackToFile("index.html");

app.Run();